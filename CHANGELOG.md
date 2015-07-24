* Always used the short commit hash for tagging. [Petros]
* Improved test script. [Aleksis]
* Switched logentries to TLS. [Petros]
* Switched to using some published modules. [Aleksis]
* Added VPN reverse proxy. [Aleksis]
* Report additional data on auth fail. [Lorenzo]

# 2015-07-17

* Changed to support newer resin-base with confd 0.10.0 [Page]
* Added VPN proxy. [Aleksis]
* Cleaned up openvpn-nc. [Aleksis]
* Disable autogeneration of openvpn services. [Petros]

# 2015-06-10

* Fix reset-all error handler [Aleksis]
* Fix VPN race condition causing incorrect online/offline state [petrosagg]
* Use less aggressive keepalive settings [petrosagg]

# 2015-05-13

v0.1.1
* Request API to reset all clients state when VPN starts and on event message failure. [Aleksis]
* Fix race condition of /dev/net/tun device node creation [petrosagg]
* Fix typo in client authentication [Page]

v0.1.0
* Switched to using resin-base. [Aleksis]
* Improved tests and made them able to be run by jenkins. [Aleksis]