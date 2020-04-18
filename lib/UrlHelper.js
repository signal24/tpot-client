const qs = require('querystring');
const crypto = require('crypto');

class UrlHelper {
    extractUrlComponents(url) {
        const urlMatches = url.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
        if (!urlMatches)
            throw new Error('the URL is invalid');
        
        const protocol = urlMatches[2] || 'http';
        const host = urlMatches[3];
        const port = urlMatches[5] ? parseInt(urlMatches[5]) : (protocol == 'https' ? 443 : 80);
        const hostWithPort = urlMatches[3] + (urlMatches[4] || '');
        return { protocol, host, port, hostWithPort };
    }

    getServerConnectionInfo(options) {
        const queryAppend = this.generateQueryAppend({
            subdomain: options.subdomain
        });

        const wsProtocol = options.server.protocol == 'https' ? 'wss' : 'ws';
        const url = wsProtocol + '://' + options.server.hostWithPort + '/create-tpot' + queryAppend;

        let headers = {};
        if (options.authKey) headers.Authorization = this.getAuthString(options.authKey)

        return { url, headers };
    }

    generateQueryAppend(query) {
        for (let key in query)
            if (query[key] === undefined)
                delete query[key];
        
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
        return 'TPoT-1 ' + result;
    }
}

module.exports = UrlHelper;