const log = require('debug')('client');
const WebSocket = require('ws');

const { ClientError } = require('./Errors');
const UrlHelper = require('./UrlHelper');
const HttpConversation = require('./HttpConversation');
// const RawConversation = require('./RawConversation');

const CONTROL_CODES = require('./TunnelControlCodes');

class Client {
    isConnected = false;
    readyResolve = null;
    options = {};
    conversations = {};
    openConversationCount = 0;

    configure(options) {
        Object.assign(this.options, options);
    }

    init() {
        return new Promise(resolve => {
            this.readyResolve = resolve;

            const helper = new UrlHelper();

            this.options.server = helper.extractUrlComponents(this.options.server);
            this.options.target = helper.extractUrlComponents(this.options.target);

            if (this.options.rewriteHost === undefined) {
                this.options.rewriteHost = this.options.target.hostWithPort;
            }

            const connectionInfo = helper.getServerConnectionInfo(this.options);
            this.connect(connectionInfo);
        });
    }

    connect({ url, headers }) {
        this.ws = new WebSocket(url, { headers });
        this.ws.on('error', this.handleWsError.bind(this));
        this.ws.on('close', this.handleWsDisconnected.bind(this));
        this.ws.on('open', this.handleWsConnected.bind(this));
        this.ws.on('message', this.handleWsMessage.bind(this));
    }

    handleWsError(err) {
        log('WebSocket error', err);
        
        if (!this.isConnected) {
            if (err.code == 'ECONNREFUSED')
                throw new ClientError('The server ' + err.message.replace(/^.*ECONNREFUSED /, '') + ' could not be reached.');
            
            const httpErrorMatches = err.message.match(/Unexpected server response: ([0-9]{3})/);
            if (httpErrorMatches) {
                if (httpErrorMatches[1] == 401)
                    throw new ClientError('The server did not authorize your request. Please check your authentication key.');
                if (httpErrorMatches[1] == 404)
                    throw new ClientError('The server returned a 404 Not Found. Please check your server URL.');
                if (httpErrorMatches[1] == 409)
                    throw new ClientError('The server returned a 409 Conflict. This likely means the subdomain you requested is already in use.');
            }
        }

        throw err;
    }

    handleWsConnected() {
        log('WebSocket connected');
        this.isConnected = true;
        this.pingInterval = setInterval(this.sendPing.bind(this), 15000);
    }

    handleWsDisconnected(code, reason) {
        clearTimeout(this.pingInterval);
        log('WebSocket disconnected', code, reason);
        process.exit(-2);
    }

    handleWsMessage(data) {
        if (!(data instanceof Buffer)) throw new Error('received unexpected data from server');
        if (data[0] == CONTROL_CODES.MSG_CONTROL) return this.handleControlMessage(data.slice(1));
        if (data[0] == CONTROL_CODES.MSG_CONVO) return this.handleConversationMessage(data.slice(1));
        throw new Error('received unexpected message type code from server');
    }

    sendPing() {
        this.ws.ping();
    }

    handleControlMessage(data) {
        if (data[0] == CONTROL_CODES.TYPE_HTTP) return this.handleNewConversation(HttpConversation, data.slice(1));
        // raw
        if (data[0] == CONTROL_CODES.CONTROL_GREETINGS) return this.handleServerGreeting(data.slice(1));
        throw new Error('received unexpected control message from server');
    }

    handleConversationMessage(data) {
        const conversationId = data.readUInt16LE(0);
        const conversation = this.conversations[conversationId];
        
        if (!conversation) {
            // throw new Error('conversation ' + conversationId + ' does not exist');
            // just ignore these for now
            return log('received conversation message ' + String.fromCharCode(data[2]) + ' for non-existent conversation ' + conversationId);
        }
        
        conversation.handleDataFromTunnel(data.slice(2));
    }

    handleServerGreeting(greeting) {
        greeting = greeting.toString('utf8');
        if (greeting.substr(0, 7) != 'TPoT/1 ') throw new Error('received unexpected greeting from server');
        
        this.tunnelUrl = this.options.server.protocol + '://' + greeting.substr(7) + '.' + this.options.server.hostWithPort;

        this.readyResolve();
        this.readyResolve = null;
    }

    handleNewConversation(handlerClass, data) {
        const conversationId = data.readInt16LE(0);
        
        if (this.conversations[conversationId])
            throw new Error('server tried to re-use an existing conversation ID');

        const conversation = new handlerClass(this, conversationId);
        this.conversations[conversationId] = conversation;
        
        this.openConversationCount++;
        log('created conversation ' + conversationId + ', now have ' + this.openConversationCount + ' open conversations');

        conversation.on('end', () => {
            this.openConversationCount--;
            delete this.conversations[conversationId];
            log('conversation ' + conversationId + ' ended, leaving ' + this.openConversationCount + ' open conversations');
        });
        
        conversation.handleRequest(data.slice(2));
    }
}

module.exports = Client;