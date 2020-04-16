const qs = require('querystring');
const crypto = require('crypto');

class ClientConnectionHelper {
    constructor(client) {
        this.client = client;
    }

    getServerUrl() {
        const url = this.parseServerUrl();
        const wsUrl = this.generateWsUrl(url);
        return wsUrl;
    }

    getHeaders() {
        let headers = {};

        if (this.client.options.authKey) {
            headers.Authorization = 'TPOT-1 ' + this.getAuthString(this.client.options.authKey);
        }

        return headers;
    }

    parseServerUrl() {
        if (!this.client.options.server)
            throw new Error('server is not specified');
        
        let matches = this.client.options.server.match(/^(https?):\/\/(.+?)(:([0-9]+))?$/);
        if (!matches)
            throw new Error('server URL is not valid');
        
        const protocol = matches[1];
        const host = matches[2];
        const port = matches[4];

        if (protocol != 'http' && protocol != 'https')
            throw new Error('server URL protocol is not valid');
        
        return {
            protocol,
            host,
            port: port || (protocol == 'https' ? 443 : 80)
        };
    }

    generateWsUrl(url) {
        const query = this.generateUrlQuery();
        const wsProtocol = url.protocol == 'https' ? 'wss' : 'ws';
        const wsUrl = wsProtocol + '://' + url.host + ':' + url.port + '/create-tpot' + query;
        return wsUrl;
    }

    generateUrlQuery() {
        let query = {};

        if (this.client.options.subdomain) {
            query.subdomain = this.client.options.subdomain;
        }
        
        if (!Object.keys(query).length)
            return '';

        return '?' + qs.stringify(query);
    }

    getAuthString(key) {
        let ts = Date.now();
        let nonce = crypto.randomBytes(32).toString('base64');
        let saltString = nonce + '\n' + ts;
        let salt = crypto.createHash('md5').update(saltString).digest().toString('hex');
        let token = crypto.pbkdf2Sync(key, salt, 32768, 128, 'sha256').toString('base64');
        let authString = saltString + '\n' + token;
        let result = Buffer.from(authString).toString('base64');
        return result;
    }
}

module.exports = ClientConnectionHelper;