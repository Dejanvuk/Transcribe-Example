import React, { Component } from 'react';

import Container from 'react-bootstrap/Container';
import Row from 'react-bootstrap/Row';
import Col from 'react-bootstrap/Col';
import Form, { Label, Control } from 'react-bootstrap/Form';
import Button from 'react-bootstrap/Button';
import ButtonGroup from 'react-bootstrap/ButtonGroup';

import { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, SAMPLE_RATE, NR_CHANNELS, SAMPLE_SIZE } from '../../util/';
import crypto from 'crypto';
import * as marshaller from '@aws-sdk/eventstream-marshaller';
import * as util_utf8_node from '@aws-sdk/util-utf8-node/';

import mic from 'microphone-stream';


import 'bootstrap/dist/css/bootstrap.min.css';
import './app.css';

class App extends Component {
    constructor(props) {
        super(props);
        this.state = {
            inputLanguage: "en-US",
            inputTextArea: "",
            start: false,
            stop: true,
            errors: []
        }
        this.rec = null;
        this.ws = null;
        this.micStream = null;
        this.eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);
    }

    componentDidMount() {
        if (window.navigator.mediaDevices.getUserMedia == null) {
            this.addError("Please update your browser!");
        }
    }

    // More info at https://docs.aws.amazon.com/transcribe/latest/dg/websocket.html
    createPresignedURL() {
        // 1. Define variables for the request in your application.
        let method = "GET";
        let service = "transcribe";
        let region = "us-east-1";
        let endpoint = "wss://transcribestreaming." + region + ".amazonaws.com:8443";
        let host = "transcribestreaming." + region + ".amazonaws.com:8443";
        let date = new Date();
        let amz_date = date.toISOString().replace(/[:\-]|\.\d{3}/g, '');
        let datestamp = date.toISOString().replace(/[:\-]|\.\d{3}/g, '').substring(0, 8);

        // 2. Create a canonical URI. The canonical URI is the part of the URI between the domain and the query string.

        let canonical_uri = "/stream-transcription-websocket";

        // 3. Create the canonical headers and signed headers.

        let canonical_headers = "host:" + host + "\n";
        let signed_headers = "host";

        // 4. Match the algorithm to the hashing algorithm SHA-256.

        let algorithm = "AWS4-HMAC-SHA256";

        // 5. Create the credential scope, which scopes the derived key to the date, Region, and service to which the request is made.

        let credential_scope = datestamp + "/" + region + "/" + service + "/" + "aws4_request";

        // 6. Create the canonical query string. Query string values must be URL-encoded and sorted by name.

        let language_code = this.state.inputLanguage;
        this.sample_rate = (language_code == "en-US" || language_code == "es_US") ? 44100 :
            (language_code == "fr-CA" || language_code == "fr-FR" || language_code == "en-GB") ? 8000 : 16000;

        let canonical_querystring = encodeURIComponent("X-Amz-Algorithm") + "=" + algorithm;
        canonical_querystring += "&" + encodeURIComponent("X-Amz-Credential") + "=" + AWS_ACCESS_KEY_ID + encodeURIComponent("/") + encodeURIComponent(credential_scope);
        canonical_querystring += "&" + encodeURIComponent("X-Amz-Date") + "=" + amz_date;
        canonical_querystring += "&" + encodeURIComponent("X-Amz-Expires") + "=" + "300";
        canonical_querystring += "&" + encodeURIComponent("X-Amz-SignedHeaders") + "=" + signed_headers;
        canonical_querystring += "&" + encodeURIComponent("language-code") + "=" + language_code;
        canonical_querystring += "&" + encodeURIComponent("media-encoding") + "=" + "pcm";
        canonical_querystring += "&" + encodeURIComponent("sample-rate") + "=" + this.sample_rate;

        // 7. Create a hash of the payload. For a GET request, the payload is an empty string.

        let payload_hash = crypto.createHash("sha256").update("", "utf8").digest("hex");

        // 8. Combine all of the elements to create the canonical request.

        let canonical_request = method + '\n'
            + canonical_uri + '\n'
            + canonical_querystring + '\n'
            + canonical_headers + '\n'
            + signed_headers + '\n'
            + payload_hash;

        // 9. Create the String to Sign

        let string_to_sign = algorithm + "\n"
            + amz_date + "\n"
            + credential_scope + "\n"
            + crypto.createHash('sha256').update(canonical_request, 'utf8').digest('hex');


        // 10. Calculate the Signature

        let signing_key = this.getSignatureKey("AWS4" + AWS_SECRET_ACCESS_KEY, datestamp, region, service);
        let signature = crypto.createHmac('sha256', signing_key).update(string_to_sign, 'utf8').digest('hex');

        // 11. Add Signing Information to the Request and Create the Request URL

        canonical_querystring += "&" + encodeURIComponent("X-Amz-Signature") + "=" + signature;
        let request_url = endpoint + canonical_uri + "?" + canonical_querystring;
        return request_url;
    }

    addError(error) {
        let errors = [...this.state.errors];
        errors.push(error);
        this.setState({ errors });
    }

    start() {
        this.setState({ start: true, stop: false });
        window.navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: SAMPLE_RATE,
                sampleSize: SAMPLE_SIZE,
                channelCount: NR_CHANNELS
            }
        })
            .then((userStream) => {
                this.handleUserStream(userStream);
            })
            .catch((err) => {
                this.addError('ERROR STARTING STREAM RECORDING! ' + err);
                this.setState({ start: false, stop: true });
            });
    }

    downSample(buffer, originalSampleRate, desiredSampleRate) {
        // Downsample the buffer to desired sample rate
        if (originalSampleRate == desiredSampleRate) return buffer;
        let newBufferLength = Math.ceil((buffer.length * desiredSampleRate) / originalSampleRate);
        let offset = 0;
        let resultBuffer = new Float32Array(newBufferLength);
        for (let i = 0; i < newBufferLength; i++) {
            resultBuffer[i] = buffer[offset];
            offset += Math.floor(originalSampleRate / desiredSampleRate);
        }

        return resultBuffer;
    }

    encode16BitPcm(buffer) {
        let resultBuffer = new ArrayBuffer(buffer.length * 2);
        let offset = 0;
        let dataView = new DataView(resultBuffer);
        for (let i = 0; i < buffer.length; i++ , offset += 2) {
            dataView.setInt16(offset, buffer[i] < 0 ? buffer[i] * 0x8000 : buffer[i] * 0x7FFF, true);
        }
        return resultBuffer;
    }

    encode32BitPcm(buffer) {
        let resultBuffer = new ArrayBuffer(buffer.length * 4);
        let offset = 0;
        let dataView = new DataView(resultBuffer);
        for (let i = 0; i < buffer.length; i++ , offset += 4) {
            dataView.setInt16(offset, buffer[i] < 0 ? buffer[i] * 0x80000000 : buffer[i] * 0x7FFF0000, true);
        }
        return resultBuffer;
    }

    /*
    resample(buffer, originalSampleRate, desiredSampleRate) {
        let factor = originalSampleRate;
        let y = desiredSampleRate;
        while (y) {
            let t = y;
            y = factor % y;
            factor = t;
        }
        this.decimate(this.interpolate(this.firFloat(buffer), originalSampleRate/factor), desiredSampleRate/factor);
        let resamplingFactor = originalSampleRate / desiredSampleRate;
    }
    */

    handleUserStream(stream) {
        //this.rec = new MediaRecorder(stream);
        this.micStream = new mic();
        this.micStream.setStream(stream);
        //Create a pre-signed S4 URL
        let pre_signed_url = this.createPresignedURL();
        this.ws = new WebSocket(pre_signed_url);
        this.ws.binaryType = "arraybuffer";

        this.ws.onopen = (event) => {
            //Start recording
            this.micStream.on('data', (rawAudioChunk) => {
                let raw = mic.toRaw(rawAudioChunk);
                let eventMessage = {
                    headers: {
                        ':message-type': {
                            type: 'string',
                            value: 'event'
                        },
                        ':event-type': {
                            type: 'string',
                            value: 'AudioEvent'
                        }
                    },
                    body: Buffer.from(this.encode16BitPcm(this.downSample(raw, SAMPLE_RATE, this.sample_rate)))
                };
                if (this.ws.readyState == this.ws.OPEN) {
                    let mrs = this.eventStreamMarshaller.marshall(eventMessage);
                    //console.log(this.eventStreamMarshaller.unmarshall(Buffer(mrs)));
                    this.ws.send(mrs);
                }
                else {
                    this.addError('Unable to send the message! ' + err);
                    this.setState({ start: false, stop: true });
                }
            });
        };

        this.ws.onmessage = (messageEvent) => {
            let messageWrapper = this.eventStreamMarshaller.unmarshall(Buffer(messageEvent.data));
            let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
            if (messageWrapper.headers[":message-type"].value === "event") {
                let results = messageBody.Transcript.Results;
                if (results.length > 0) {
                    if (results[0].Alternatives.length > 0) {
                        let transcript = results[0].Alternatives[0].Transcript;
                        transcript = decodeURIComponent(escape(transcript));
                        if (!results[0].IsPartial) {
                            let input = this.state.inputTextArea + " " + transcript + "\n";
                            this.setState({ inputTextArea: input });
                        }
                    }
                }
            }
            else {
                this.addError("Invalid message received! " + messageBody.Message);
            }
        };


        this.ws.onerror = (event) => {
        };

        this.ws.onclose = (closeEvent) => {
            // check if the server closed the connection
            if (closeEvent.reason) this.addError("WebSocket error!" + closeEvent.reason);
        };

    }

    clearInputs() {
        this.setState({
            inputLanguage: "en-US",
            inputTextArea: "",
            start: false,
            stop: true,
            errors: []
        });
    }

    stop() {
        let wsState = this.ws.readyState;
        if ((wsState != this.ws.CONNECTING) && (wsState == this.ws.OPEN)) {
            //this.rec.stop();
            this.micStream.stop();
            let eventMessage = {
                headers: {
                    ':message-type': {
                        type: 'string',
                        value: 'event'
                    },
                    ':event-type': {
                        type: 'string',
                        value: 'AudioEvent'
                    }
                },
                body: Buffer.from(new Buffer([]))
            };
            let emptyBuffer = this.eventStreamMarshaller.marshall(eventMessage);
            this.ws.send(emptyBuffer);
            this.ws.close();
            this.setState({
                start: false,
                stop: true
            });
        }
    }

    handleChange(e) {
        let state = { ...this.state };
        state[e.target.name] = e.target.value;
        this.setState(state);
    }

    getSignatureKey(secret_key, datestamp, regionName, serviceName) {
        let kDate = this.createSha256Hmac(secret_key, datestamp);
        let kRegion = this.createSha256Hmac(kDate, regionName);
        let kService = this.createSha256Hmac(kRegion, serviceName);

        return this.createSha256Hmac(kService, "aws4_request");
    }

    createSha256Hmac(secret, text) {
        let hmac = crypto.createHmac('sha256', secret);
        hmac.write(text);
        hmac.end();
        let hash = hmac.read();
        // return hmac digest
        return hash;
    }

    render() {
        const { inputTextArea, inputLanguage, start, stop, errors } = this.state;
        return (
            <div className="App">
                <Container>
                    <h1>
                        Audio Transcription using WebSocket API
                    </h1>
                    <Row>
                        <Col align="center">
                            {(errors.length) ? errors.map((error, i) => <h3 className="error" key={i}>{error}</h3>) : ""}
                        </Col>
                    </Row>
                    <Row>
                        <Col>
                            <Form.Label>Input language:</Form.Label>
                            <Form.Control name="inputLanguage" defaultValue={inputLanguage} onChange={this.handleChange.bind(this)} as="select">
                                <option value="en-US">US English</option>
                                <option value="en-GB">GB English</option>
                                <option value="fr-FR">France french</option>
                                <option value="fr-CA">Canada french</option>
                                <option value="es-US">US Spanish</option>
                            </Form.Control>
                        </Col>
                    </Row>
                    <Row>
                        <Col>
                            <Form.Control id="blabla" rows="5" name="inputTextArea" value={inputTextArea} onChange={this.handleChange.bind(this)} as="textarea" readOnly></Form.Control>
                        </Col>
                    </Row>
                    <Row>
                        <Col align="center">
                            <ButtonGroup className="Buttons" aria-label="Basic example">
                                <Button className="btn-group" id="btn-start" onClick={this.start.bind(this)} variant="primary" disabled={start}>Start</Button>
                                <Button className="btn-group" id="btn-stop" onClick={this.stop.bind(this)} variant="primary" disabled={stop}>Stop</Button>
                                <Button className="btn-group" id="btn-reset" onClick={this.clearInputs.bind(this)} variant="primary">Reset</Button>
                            </ButtonGroup>
                        </Col>
                    </Row>
                </Container>
            </div>
        );
    }
}

export default App;
