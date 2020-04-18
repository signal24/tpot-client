#!/usr/bin/env node

const fs = require('fs');
const { program } = require('commander');

let config = {};

program
    .option('-t, --tpot-server <server>', 'the URL of the TPoT server')
    .option('-k, --auth-key <key>', 'authentication key')
    .option('-s, --subdomain <subdomain>', 'request a specific subdomain')
    .option('-h, --http-host <host>', 'override Host header rewrite')
    .option('-nh, --no-host-rewrite', 'disable Host header rewrite')
    .option('-d, --debug', 'enable debug logging');

program.command('http <target>').description('create a tunnel to an HTTP(S) server').action(inTarget => {
    config.proto = 'http';
    config.target = inTarget;
});

program.parse(process.argv);

if (program.debug) {
    require('debug').enable('*');
}

try {
    const storedJson = fs.readFileSync(process.env.HOME + '/.tpot/config.json');
    let parsedConfig = JSON.parse(storedJson);

    if (typeof(parsedConfig) == 'object' && parsedConfig != null && !Array.isArray(parsedConfig)) {
        config = Object.assign(parsedConfig, config);
    } else {
        process.stderr.write('WARNING: Your configuration file at ~/.tpot/config.json appears to be corrupt.\n');
    }
}

catch (err) {
    if (err.code == 'ENOENT') {
        // do nothing. file just doesn't exist.
    } else if (/^Unexpected token.*in JSON/.test(err.message)) {
        process.stderr.write('WARNING: Your configuration file at ~/.tpot/config.json appears to be corrupt.\n');
    } else {
        throw err;
    }
}

if (program.tpotServer) config.tpotServer = program.tpotServer;
if (program.authKey) config.authKey = program.authKey;
if (program.subdomain) config.subdomain = program.subdomain;
if (program.httpHost) config.httpHost = program.httpHost;
if (program.noHostRewrite) config.noHostRewrite = program.noHostRewrite;

if (!config.tpotServer) die('Server is not specified by configuration file or CLI option.');

const serverMatches = config.tpotServer.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
if (!serverMatches) die('Server is not valid. Examples of valid formats:\n  tpot.sgnl24.com\n  tpot.sgnl24.com:1234\n  http://tpot.sgnl24.com\n  https://tpot.sgnl24.com\n  https://tpot.sgnl24.com:1234');

if (program.subdomain) {
    const subdomainMatches = program.subdomain.match(/^[a-z0-9-]{1,24}$/);
    if (!subdomainMatches) die('Subdomain is not valid. Subdomains may contain uppercase and lowercase letters, digits 0-9, and hypens, but must not start with a hyphen.');
}

const targetMatches = config.target.match(/^((https?):\/\/)?([a-z0-9.]+)(:([0-9]+))?\/?$/i);
if (!targetMatches) die('Target is not valid. Examples of valid formats:\n  127.0.0.1\n  127.0.0.1:8080\n  http://127.0.0.1\n  https://127.0.0.1\n  https://localhost:1234');

if (targetMatches[2] === 'https') die('HTTPS targets not yet implemented. Check back soon!');


const { ClientError } = require('./lib/Errors');
const Client = require('./lib/Client');
const client = new Client();

client.configure({
    server: config.tpotServer,
    authKey: config.authKey,
    subdomain: config.subdomain,
    target: config.target,
    rewriteHost: config.noHostRewrite ? false : config.httpHost
});

const errHandler = err => {
    if (err instanceof ClientError) {
        process.stderr.write(err.message);
        process.stderr.write('\n');
    } else {
        console.error(err);
    }

    process.exit(-1);
};

process.on('unhandledRejection', errHandler);
process.on('uncaughtException', errHandler);

(async () => {
    await client.init();
    
    process.stdout.write('tpot connected\n');
    process.stdout.write(`${client.tunnelUrl}\n`);
})();