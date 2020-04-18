### TPoT (Transport Packets over Tunnels)
A simple (optionally authenticated) remote development/test/demo proxy over HTTP, powered by WebSockets. No additional ports required. Designed to be used with a reverse proxy for TLS.

***

### Requirements

* Developed & tested against Node 12.
* Must have a [TPoT server](http://github.com/signal24/tpot-server) online.


### Installation
```
npm -g install tpot
```


### Usage
```
Usage: tpot [options] [command]

Options:
  -t, --tpot-server <server>   the URL of the TPoT server
  -k, --auth-key <key>         authentication key
  -s, --subdomain <subdomain>  request a specific subdomain
  -h, --http-host <host>       override Host header rewrite
  -nh, --no-host-rewrite       disable Host header rewrite
  -d, --debug                  enable debug logging
  -h, --help                   display help for command

Commands:
  http <target>                create a tunnel to an HTTP(S) server
  help [command]               display help for command
```


### Example
Simply run:
```
tpot http localhost:8080
```

and you shall be greeted:
```
tpot connected
https://nz2v6g7o.tpot.sgnl24.com
```

Now, any traffic to `https://nz2v6g7o.tpot.sgnl24.com/feed/me/data` will be tunneled to `http://localhost:8080/feed/me/data`.

CTRL+C to quit when you're done.


### Configuration

If you don't want to specify the server and authentication key (if required) every time you connect, or if you want to consistently request a specific subdomain, you can do so with a configuration file.

**~/.tpot/config.json:**
```
{
  "tpotServer": "https://your-tpot-host-url",
  "authKey": "your-auth-key-here",
  "subdomain": "my-nickname"
}
```

The camel-cased version of any option from the usage (above) can be included in the config file.

***

### How does this work?

WebSockets.

The client connects to the server over a WebSocket (HTTP or HTTPS), and either requests a specific subdomain, or the server randomly assigns it one.  When the server receives a request for your assigned subdomain, it opens a new "conversation" by assigning a conversation ID for that tunnel, and sending a message to your client with the conversation ID, the conversation type (just HTTP for now; raw data in the future), and the sender IP and port. The server then just forwards all the raw data it receives over the WebSocket, prefixed with the conversation ID. The client does the same, just in reverse.

In the case of HTTP conversations, the client analyzes the inbound traffic so that it can rewrite the HTTP host header. This behavior is enabled by default, but can be disabled using the `--no-host-rewrite` flag.

### Is this secure?

That depends on your setup.

If you expose your server over HTTPS, then all communication between the client and server is secure, and all communication between the remote user and the server is secure. Don't confuse this with end-to-end encryption: the server still has to decrypt the data to know which tunnel to send it through. As long as you trust that your server is secure, then you can trust that communication from the remote user to your TPoT client is secure.

As for the security from your TPoT client to your target... that's up to you.

*NOTE: HTTPS target support is right around the corner.*


### How is this any different than ngrok, localtunnel, etc?

Most importantly: it's open source, and fully under your control!

We accidentally ran into the upper limit of ngrok's per-minute connection limit, and didn't like that the paid plans had what still felt like low limits.

localtunnel seemed decent, but it opened random ports to establish connections, which wasn't compatible with trying to run the server as a simple deployment on our Kubernetes cluster.

For HTTP/S support (which is the only thing supported at the moment!), TPoT's server needs nothing more than a single port, which can run on its own dedicated cloud server, or as a container in a Kubernetes deployment, behind an nginx ingress controller (which is how we run it). All traffic for both the clients and the remote users is routed through the single port.


### Where are the tests??

Feel free to write them :)