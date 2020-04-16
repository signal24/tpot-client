const EventEmitter = require('events').EventEmitter;
const logGenerator = require('debug');
const net = require('net');

const CONTROL_CODES = require('./TunnelControlCodes');

class Conversation extends EventEmitter {
    constructor(type, client, id) {
        super();

        this.client = client;
        this.id = id;

        this.log = logGenerator(type + '-' + id);
        
        this.isTunnelConvoOpen = true;
        this.isUpstreamConnected = false;
        this.initialBuffer = [];

        this.bytesForwardedThroughTunnel = 0;
        this.bytesForwardedUpstream = 0;
    }


    /******************
     * SETUP
     *****************/

    handleRequest(sourceInfo) {
        const ipComponents = [];
        ipComponents[0] = sourceInfo.readUInt8(0);
        ipComponents[1] = sourceInfo.readUInt8(1);
        ipComponents[2] = sourceInfo.readUInt8(2);
        ipComponents[3] = sourceInfo.readUInt8(3);

        this.clientIp = ipComponents.join('.');
        this.clientPort = sourceInfo.readUInt16LE(4);

        this.log('handling request from ' + this.clientIp + ':' + this.clientPort);

        this.upstreamSocket = net.connect(this.client.options.target.port, this.client.options.target.host);
        this.upstreamSocket.on('error', this.handleUpstreamSocketError.bind(this));
        this.upstreamSocket.on('close', this.handleUpstreamSocketClosed.bind(this));
        this.upstreamSocket.on('connect', this.handleUpstreamSocketConnected.bind(this));
        this.upstreamSocket.on('data', this.handleUpstreamSocketDataReceived.bind(this));
        this.upstreamSocket.on('drain', this.handleUpstreamSocketWriteDrained.bind(this));

        // TODO: add connection timeout
    }


    /******************
     * LOCAL SOCKET HANDLERS
     *****************/

    handleUpstreamSocketConnected() {
        this.log('upstream ' + this.upstreamSocket.remoteAddress + ':' + this.upstreamSocket.remotePort + ' connected from ' + this.upstreamSocket.localAddress + ':' + this.upstreamSocket.localPort);
        this.isUpstreamConnected = true;

        const initialBuffer = Buffer.concat(this.initialBuffer);
        this.upstreamSocket.write(initialBuffer);

        this.initialBuffer = null;
    }

    handleUpstreamSocketDataReceived(data) {
        this.forwardDataThroughTunnel(data);
    }

    handleUpstreamSocketWriteDrained() {
        this.sendTunnelControlMessage(CONTROL_CODES.CONVO_RESUME);
    }


    /******************
     * TUNNEL HANDLERS
     *****************/
    
    handleDataFromTunnel(data) {
        if (data[0] == CONTROL_CODES.CONVO_DATA)
            return this.forwardUpstream(data.slice(1));
        if (data[0] == CONTROL_CODES.CONVO_PAUSE)
            return this.invokeUpstreamSocketMethod('pause');
        if (data[0] == CONTROL_CODES.CONVO_RESUME)
            return this.invokeUpstreamSocketMethod('resume');
        if (data[0] == CONTROL_CODES.CONVO_CLOSED)
            return this.handleTunnelClientClosed();
        
        throw new TunnelError('unhandled conversation control code');
    }


    /******************
     * OUTPUT FUNCTIONS
     *****************/

    sendTunnelControlMessage(controlCode) {
        if (!this.isTunnelConvoOpen) return false;

        const outBuffer = Buffer.allocUnsafe(4);
        outBuffer.writeUInt8(CONTROL_CODES.MSG_CONVO, 0);
        outBuffer.writeUInt16LE(this.id, 1);
        outBuffer.writeUInt8(controlCode, 3);
        this.client.ws.send(outBuffer);
    }

    forwardDataThroughTunnel(data) {
        if (!this.isTunnelConvoOpen) return false;
        
        const outBuffer = Buffer.allocUnsafe(4 + data.length);
        outBuffer.writeUInt8(CONTROL_CODES.MSG_CONVO, 0);
        outBuffer.writeUInt16LE(this.id, 1);
        outBuffer.writeUInt8(CONTROL_CODES.CONVO_DATA, 3);
        data.copy(outBuffer, 4);
        this.client.ws.send(outBuffer);
        
        this.bytesForwardedThroughTunnel += data.length;
    }

    forwardUpstream(data) {
        if (!this.isUpstreamConnected) {
            if (this.initialBuffer != null) {
                this.initialBuffer.push(data);
            }

            return;
        }

        const shouldContinueWriting = this.upstreamSocket.write(data);
        if (!shouldContinueWriting) this.sendTunnelControlMessage(CONTROL_CODES.CONVO_PAUSE);

        this.bytesForwardedUpstream += data.length;
    }

    invokeUpstreamSocketMethod(method) {
        if (!this.isUpstreamConnected) return;
        this.upstreamSocket[method]();
    }


    /******************
     * TEARDOWN
     *****************/

    handleTunnelClientClosed() {
        this.log('downstream client disconnected');
        this.isTunnelConvoOpen = false;
        this.isUpstreamConnected && this.upstreamSocket.end();
        this.checkForEnd();
    }
    
    handleUpstreamSocketError(err) {
        this.log('upstream socket error', err);

        if (!this.isUpstreamConnected) {
            this.sendTunnelControlMessage(CONTROL_CODES.CONVO_NOCONNECT);
            return;
        }
        
        this.isUpstreamConnected = false;
        this.closeTunnelConvo();
    }

    handleUpstreamSocketClosed(hadError) {
        if (hadError)
            this.log('upstream disconnected with error');
        else
            this.log('upstream disconnected');
        
        this.isUpstreamConnected = false;
        this.closeTunnelConvo();
    }

    closeTunnelConvo() {
        if (this.isTunnelConvoOpen) {
            this.sendTunnelControlMessage(CONTROL_CODES.CONVO_CLOSED);
            this.isTunnelConvoOpen = false;
        }

        this.checkForEnd();
    }

    checkForEnd() {
        if (this.isTunnelConvoOpen) return;
        if (this.isUpstreamConnected) return;
        if (this.hasEnded) return;
        this.hasEnded = true;
        this.emit('end');

        this.log('transmitted %d bytes upstream, %d bytes downstream', this.bytesForwardedUpstream, this.bytesForwardedThroughTunnel);
    }
}

module.exports = Conversation;