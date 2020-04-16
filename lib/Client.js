const log = require('debug')('client');
const WebSocket = require('ws');
const ConnectionHelper = require('./ClientConnectionHelper');
const HttpConversation = require('./HttpConversation');
// const RawConversation = require('./RawConversation');
const URL = require('url').URL;

const CONTROL_CODES = require('./TunnelControlCodes');

class Client {
    isConnected = false
    options = {};
    conversations = {};
    openConversationCount = 0;

    configure(options) {
        Object.assign(this.options, options);
    }

    init() {
        this.extractTargetUrlComponents();
        this.connect();
    }

    extractTargetUrlComponents() {
        const url = new URL(this.options.target);
        const protocol = url.protocol.replace(/:$/, '');
        const host = url.hostname;
        const port = url.port ? parseInt(url.port) : (protocol == 'https' ? 443 : 80);
        this.options.target = { protocol, host, port };
        
        if (!this.options.rewriteHost)
            this.options.rewriteHost = host + (url.port ? `:${url.port}` : '');
    }

    connect() {
        let helper = new ConnectionHelper(this);
        let url = helper.getServerUrl();
        let headers = helper.getHeaders();
        
        this.ws = new WebSocket(url, { headers });
        this.ws.on('error', this.handleWsError.bind(this));
        this.ws.on('close', this.handleWsDisconnected.bind(this));
        this.ws.on('open', this.handleWsConnected.bind(this));
        this.ws.on('message', this.handleWsMessage.bind(this));
    }

    handleWsError(err) {
        log('WebSocket error', err);
        
        if (!this.isConnected && err.message.includes('Unexpected server response: 401'))
            die('The server did not authorize your request. Please check your authentication key and try again.');
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
        if (greeting.substr(0, 7) != 'TPOT/1 ') throw new Error('received unexpected greeting from server');
        this.host = greeting.substr(7);
        process.stdout.write(`tpot connected\n\https://${this.host}\n\n`);
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