/*
	Copyright (C) 2017 Balena Ltd.

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published
	by the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { metrics } from '@balena/node-metrics-gatherer';
import * as Bluebird from 'bluebird';
import * as dns from 'dns';
import * as _ from 'lodash';
import * as net from 'net';
import * as nodeTunnel from 'node-tunnel';
import * as winston from 'winston';

import { captureException, device, errors, getLogger, Metrics } from './utils';

const VPN_SERVICE_API_KEY = Buffer.from(process.env.VPN_SERVICE_API_KEY!);
const VPN_CONNECT_PROXY_PORT = parseInt(
	process.env.VPN_CONNECT_PROXY_PORT!,
	10,
);

const lookupAsync = Bluebird.promisify(dns.lookup);

class Tunnel extends nodeTunnel.Tunnel {
	private readonly logger: winston.Logger;

	constructor(
		private readonly instanceId: number,
		private readonly serviceId: number,
	) {
		super();
		this.logger = getLogger('proxy', this.instanceId, this.serviceId);

		this.on('error', err => {
			// errors thrown in `this.connect` will appear here
			if (!(err instanceof errors.HandledTunnelingError)) {
				this.logger.crit(
					`failed to connect to device (${err.message || err})\n${err.stack}`,
				);
				captureException(err, 'proxy-connect-error');
			}
		});

		this.use(this.tunnelToDevice);
	}

	public connect = (
		port: number,
		host: string,
		client: net.Socket,
		req: nodeTunnel.Request,
	) =>
		Bluebird.try(() => this.parseRequest(req)).then(({ uuid, auth }) =>
			lookupAsync(`${uuid}.vpn`)
				.return(true)
				.catchReturn(false)
				.then(exists => {
					if (exists) {
						// The lookup succeeded so we try to connect
						this.logger.info(`connecting to ${host}:${port}`);
						return super.connect(port, host, client, req).tap(socket => {
							metrics.inc(Metrics.ActiveTunnels);
							metrics.inc(Metrics.TotalTunnels);
							socket.on('close', () => {
								metrics.dec(Metrics.ActiveTunnels);
							});
						});
					} else {
						// The lookup failed so we try to forward to the correct vpn instance instead
						return device
							.getDeviceVpnHost(uuid, auth)
							.catch(err => {
								if (err instanceof errors.APIError) {
									this.logger.crit(
										`error connecting to ${uuid}:${port} (${err.message})`,
									);
									throw new errors.HandledTunnelingError(err.message);
								}
								throw err;
							})
							.then(vpnHost => {
								if (vpnHost.id === this.serviceId) {
									throw new errors.HandledTunnelingError(
										'device is not available on registered service instance',
									);
								}
								this.logger.info(
									`forwarding tunnel request for ${uuid}:${port} via ${vpnHost.id}@${vpnHost.ip_address}`,
								);
								return this.forwardRequest(
									vpnHost.ip_address,
									uuid,
									port,
									auth,
								).catch(errors.RemoteTunnellingError, err => {
									this.logger.crit(
										`error forwarding request for ${uuid}:${port} (${err.message})`,
									);
									throw new errors.HandledTunnelingError(err.message);
								});
							});
					}
				}),
		);

	public start = (port: number) => {
		this.listen(port, () => {
			this.logger.notice(`tunnel listening on port ${port}`);
		});
	};

	private parseRequest = (req: nodeTunnel.Request) => {
		if (req.url == null) {
			throw new errors.BadRequestError();
		}

		const match = req.url.match(
			/^([a-fA-F0-9]+)\.(balena|resin|vpn)(?::([0-9]+))?$/,
		);
		if (match == null) {
			throw new errors.InvalidHostnameError(`invalid hostname: ${req.url}`);
		}
		const [, uuid, tld, port = '80'] = match;
		if (tld === 'resin') {
			this.logger.warning(`'.resin' tld is deprecated, use '.balena'`);
		}

		let auth;
		if (req.auth != null && req.auth.password != null) {
			auth = Buffer.from(req.auth.password);
		}

		return { uuid, port: parseInt(port, 10), auth };
	};

	private tunnelToDevice: nodeTunnel.Middleware = (
		req,
		cltSocket,
		_head,
		next,
	) =>
		Bluebird.try(() => {
			const { uuid, port, auth } = this.parseRequest(req);
			this.logger.info(`tunnel requested to ${uuid}:${port}`);

			// we need to use VPN_SERVICE_API_KEY here as this could be an unauthenticated request
			return device
				.getDeviceByUUID(uuid, VPN_SERVICE_API_KEY)
				.tap(data => {
					if (data == null) {
						cltSocket.end('HTTP/1.0 404 Not Found\r\n\r\n');
						throw new errors.HandledTunnelingError(`device not found: ${uuid}`);
					}
					return device.canAccessDevice(data, port, auth).tap(isAllowed => {
						if (!isAllowed) {
							cltSocket.end(
								'HTTP/1.0 407 Proxy Authorization Required\r\n\r\n',
							);
							throw new errors.HandledTunnelingError(
								`device not accessible: ${uuid}`,
							);
						}
						if (!data.is_connected_to_vpn) {
							cltSocket.end('HTTP/1.0 503 Service Unavailable\r\n\r\n');
							throw new errors.HandledTunnelingError(
								`device not available: ${uuid}`,
							);
						}
					});
				})
				.then(() => {
					req.url = `${uuid}.vpn:${port}`;
					return next();
				});
		}).catch((err: Error) => {
			if (err instanceof errors.APIError) {
				this.logger.alert(`Invalid Response from API (${err.message})`);
				cltSocket.end('HTTP/1.0 500 Internal Server Error\r\n\r\n');
			} else if (err instanceof errors.BadRequestError) {
				cltSocket.end('HTTP/1.0 400 Bad Request\r\n\r\n');
			} else if (err instanceof errors.HandledTunnelingError) {
				this.logger.crit(`Tunneling Error (${err.message})`);
			} else if (err instanceof errors.InvalidHostnameError) {
				cltSocket.end('HTTP/1.0 403 Forbidden\r\n\r\n');
			} else {
				captureException(err, 'proxy-tunnel-error', { req });
				cltSocket.end('HTTP/1.0 500 Internal Server Error\r\n\r\n');
			}
		});

	private forwardRequest = (
		vpnHost: string,
		uuid: string,
		port: number,
		proxyAuth?: Buffer,
	): Bluebird<net.Socket> =>
		new Bluebird((resolve, reject) => {
			let tunnelProxyResponse = '';
			const socket: net.Socket = net.connect(3128, vpnHost, () => {
				socket.write(`CONNECT ${uuid}.balena:${port} HTTP/1.0\r\n`);
				if (proxyAuth != null) {
					socket.write(
						`Proxy-Authorization: Basic ${proxyAuth.toString('base64')}\r\n`,
					);
				}
				socket.write('\r\n\r\n');
			});

			const earlyEnd = () => {
				reject(
					new errors.RemoteTunnellingError(
						`could not connect to ${uuid}:${port}: tunneling socket closed prematurely`,
					),
				);
			};
			const earlyError = (err: Error) => {
				let errMsg = 'could not connect to vpn tunnel';
				if (err != null && err.message) {
					errMsg += `: ${err.message}`;
				}
				this.logger.warning(errMsg);
				captureException(err, 'proxy-forward-error');
				reject(new errors.RemoteTunnellingError(errMsg));
			};
			const proxyData = (chunk: Buffer) => {
				// read 'data' chunks until full HTTP status line has been read
				tunnelProxyResponse += chunk.toString();
				if (!_.includes(tunnelProxyResponse, '\r\n\r\n')) {
					return;
				}
				socket.removeListener('data', proxyData);
				socket.removeListener('end', earlyEnd);
				socket.removeListener('error', earlyError);

				// RFC2616: Status-Line = HTTP-Version SP Status-Code SP Reason-Phrase CRLF
				const httpStatusLine = tunnelProxyResponse.split('\r\n')[0];
				const httpStatusCode = parseInt(httpStatusLine.split(' ')[1], 10);

				if (httpStatusCode !== 200) {
					return reject(
						new errors.RemoteTunnellingError(
							`could not connect to ${uuid}:${port}: ${httpStatusLine}`,
						),
					);
				}
				resolve(socket);
			};

			socket
				.on('end', earlyEnd)
				.on('error', earlyError)
				.on('data', proxyData);
		});
}

const worker = (instanceId: number, serviceId: number) => {
	getLogger('proxy', instanceId, serviceId).info(
		`process started with pid=${process.pid}`,
	);

	const tunnel = new Tunnel(instanceId, serviceId);
	tunnel.start(VPN_CONNECT_PROXY_PORT);
	return tunnel;
};
export default worker;