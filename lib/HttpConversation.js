const Conversation = require('./Conversation');

class HttpConversation extends Conversation {
    constructor(client, id) {
        super('http', client, id);

        this.isInspectionEnabled = true;
        this.isRequestInFlight = false;
        this.isInFlightRequestKeepAlive = false;
        this.isInFlightRequestChunked = false;
        this.expectedChunkBytesRemaining = 0;
        this.queuedChunks = [];
    }

    forwardUpstream(data) {
        if (this.isInspectionEnabled) {
            if (!this.isRequestInFlight) {
                data = this.processInitialRequestData(data);
                if (!data) return;
            }

            if (this.isInFlightRequestKeepAlive) {
                return this.processDataForKARequest(data);
            }
        }

        super.forwardUpstream(data);
    }

    handleUpstreamSocketDataReceived(data) {
        // we'll use this later for capturing the end of each request to get the response headers,
        // bytes transferred, and maybe even the body itself for web inspection
        super.handleUpstreamSocketDataReceived(data);
    }


    /******************
     * HTTP REQUEST PROCESSING
     *****************/

    processInitialRequestData(data) {
        const headerEndPosition = data.indexOf('\r\n\r\n');
        if (headerEndPosition < 0) {
            this.queuedChunks.push(data);
            return null;
        }

        this.isRequestInFlight = true;

        const fullBuffer = this.queuedChunks.length ? Buffer.concat([ ...this.queuedChunks, data ]) : data;
        this.queuedChunks = [];

        const absoluteHeaderEndPosition = fullBuffer.length - data.length + headerEndPosition + 4;
        const headerBuffer = fullBuffer.slice(0, absoluteHeaderEndPosition);

        const shouldContinue = this.processHeaders(headerBuffer);

        // if we've been told not to continue, it's because we didn't understand the request, so we're just
        // going to switch into flow mode and stop trying to interpret the conversation
        if (!shouldContinue) {
            this.disableInspection('did not understand headers')
            return fullBuffer;
        }

        // if there's no more data left
        if (fullBuffer.length == absoluteHeaderEndPosition) {
            // if this request is keep-alive, the request isn't chunked, and we're not expecting any more chunk bytes,
            // then the request must've been a simple one with no body, so we can consider it finished
            if (this.isInFlightRequestKeepAlive && !this.isInFlightRequestChunked && this.expectedChunkBytesRemaining == 0) {
                this.clearInFlightRequest();
            }

            return null;
        }
        
        const bodyBuffer = fullBuffer.slice(absoluteHeaderEndPosition);
        return bodyBuffer;
    }

    processHeaders(headerBuffer) {
        let headerString = headerBuffer.toString('utf8');

        const requestLine = headerString.match(/^([A-Z]+) ([^ ]+) HTTP\/.+/);
        if (!requestLine) return null;

        const method = requestLine[1];
        const url = requestLine[2];
        this.log(method, url);
        
        const hostMatch = headerString.match(/^host: .*$/mi);
        if (!hostMatch) return null;

        headerString = headerString.substr(0, hostMatch.index + 6) + this.client.options.rewriteHost + headerString.substr(hostMatch.index + hostMatch[0].length);
        
        const connectionMatch = headerString.match(/^connection: .*$/mi);
        if (connectionMatch) {
            this.isInFlightRequestKeepAlive = connectionMatch[0].includes('keep-alive');
            this.log('connection header:', connectionMatch[0]);
        } else {
            this.isInFlightRequestKeepAlive = true;
            this.log('no connection header specified. assuming keep-alive.');
        }

        if (this.isInFlightRequestKeepAlive) {
            const transferEncodingMatch = headerString.match(/^transfer-encoding: (.*)$/mi);
            if (transferEncodingMatch) {
                this.log('chunked transfer encoding enabled');
                this.isInFlightRequestChunked = transferEncodingMatch[0].includes('chunked');
            }

            if (!this.isInFlightRequestChunked) {
                const contentLengthMatch = headerString.match(/^content-length: ([0-9]+)$/mi);
                if (contentLengthMatch) {
                    this.expectedChunkBytesRemaining = parseInt(contentLengthMatch[1]);
                    this.log('expecting ' + this.expectedChunkBytesRemaining + ' bytes');
                } else {
                    this.log('no content length specified');
                }
            }
        }

        super.forwardUpstream(Buffer.from(headerString));

        return true;
    }

    processDataForKARequest(data) {
        super.forwardUpstream(data);

        if (this.isInFlightRequestChunked)
            this.processChunkedDataForKARequest(data);
        else
            this.processNonchunkedDataForKARequest(data);
    }

    processChunkedDataForKARequest(data) {
        if (this.expectedChunkBytesRemaining == 0) {
            const crLfPosition = data.indexOf('\r\n');
            if (crLfPosition < 0) return this.disableInspection('chunked content did not contained expected header segment');

            const headerSegment = data.slice(0, crLfPosition).toString('utf8');
            const headerSegmentComponents = headerSegment.match(/^([0-9a-fA-F]+)($|;)/);
            if (!headerSegmentComponents) return this.disableInspection('chunked content header segment did not match expected format');

            this.expectedChunkBytesRemaining = parseInt(headerSegmentComponents[1], 16);

            // if the expect chunk bytes remaining is still 0, then this is the end of the data.
            // make sure we have two CRLFs and reset us for the next request
            // NOTE: we may have to improve this later if HTTP trailers w/ TCP segmentation are breaking the detection of the true end
            if (this.expectedChunkBytesRemaining == 0) {
                const doubleCrLfPosition = data.indexOf('\r\n\r\n');
                if (doubleCrLfPosition < 0) return this.disableInspection('chunked content end signal (0 len) did not contain expected double CRLF');
                if (data.length > doubleCrLfPosition + 4) return this.disableInspection('chunked content end signal (0 len) contains data after double CRLF');
                return this.clearInFlightRequest();
            }

            data = data.slice(crLfPosition + 2);
        }

        if (data.length < this.expectedChunkBytesRemaining) {
            this.expectedChunkBytesRemaining -= data.length;
            return;
        }

        const dataAfterChunk = data.slice(this.expectedChunkBytesRemaining);
        if (dataAfterChunk[0] != 13 /*CR*/ || dataAfterChunk[1] != 10 /*LF*/)
            return this.disableInspection('chunked content segment does not end with expected CRLF');

        this.expectedChunkBytesRemaining = 0;
        
        // if there's nothing after the CRLF, we're done here
        if (dataAfterChunk.length == 2)
            return;
        
        this.processChunkedDataForKARequest(dataAfterChunk.slice(2));
    }

    processNonchunkedDataForKARequest(data) {
        this.expectedChunkBytesRemaining -= data.length;

        if (this.expectedChunkBytesRemaining < 0)
            return this.disableInspection('data size exceeded content length expectation');

        if (this.expectedChunkBytesRemaining == 0)
            this.clearInFlightRequest();
    }

    clearInFlightRequest() {
        this.isRequestInFlight = false;
        this.isInFlightRequestKeepAlive = false;
        this.isInFlightRequestChunked = false;
        this.expectedChunkBytesRemaining = 0;
        this.log('request segment ended');
    }

    disableInspection(reason) {
        this.log(reason + '. switching into flowing mode.');
        this.isInspectionEnabled = false;
    }
}

module.exports = HttpConversation;