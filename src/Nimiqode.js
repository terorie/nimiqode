class Nimiqode {
    /**
     * @param {Uint8Array|Array.<HexagonRing>} payloadOrHexRings
     * @param {number|BitArray} [errorCorrectionFactorOrData]
     * @param {number} [version]
     * @return {Promise.<Nimiqode>|null} instance or in case of error null
     */
    constructor(payloadOrHexRings, errorCorrectionFactorOrData=NimiqodeSpecification.DEFAULT_FACTOR_ERROR_CORRECTION_DATA,
                version=0) {
        if (Array.isArray(payloadOrHexRings)) {
            return this._constructFromScan(payloadOrHexRings, errorCorrectionFactorOrData);
        } else {
            return this._constructFromPayload(payloadOrHexRings, errorCorrectionFactorOrData, version);
        }
    }

    async _constructFromPayload(payload, errorCorrectionFactor, version) {
        if (!(payload instanceof Uint8Array) || version !== NimiqodeSpecification.CURRENT_VERSION ||
            payload.byteLength === 0) {
            throw Error('Invalid argument.');
        }
        if (errorCorrectionFactor<0 || errorCorrectionFactor>NimiqodeSpecification.MAX_FACTOR_ERROR_CORRECTION_DATA) {
            throw Error('Illegal error correction factor.');
        }
        if (payload.length * 8 > Math.pow(2, NimiqodeSpecification.HEADER_LENGTH_PAYLOAD_LENGTH) * 8) {
            throw Error(`Your data is too long. Supported are up to
                ${Math.pow(2, NimiqodeSpecification.HEADER_LENGTH_PAYLOAD_LENGTH)} bytes.`);
        }
        const payloadBitArray = new BitArray(payload);
        this._payload = payload;
        const preliminaryErrorCorrectionLength = Math.ceil(payloadBitArray.length * errorCorrectionFactor);
        this._hexagonRings = [];
        const dataLength = this._createHexagonRings(payloadBitArray.length, preliminaryErrorCorrectionLength);
        const checksum = CRC16.crc16(payload);

        // create bit arrays
        this._data = new BitArray(dataLength);
        const hexRingMaskCount = NimiqodeHeader.calculateMaskCount(this._hexagonRings);
        const headerLength = NimiqodeHeader.calculateLength(hexRingMaskCount);
        const header = new BitArray(this._data, 0, headerLength);
        // Use all of the remaining bits which can be more than the preliminaryErrorCorrectionLength bits by filling up
        // empty leftover space in the last hexagon ring.
        const errorCorrectionLength = dataLength - headerLength - payloadBitArray.length;
        const encodedPayload = new BitArray(this._data, headerLength, headerLength + payloadBitArray.length +
            errorCorrectionLength);

        // assemble data
        const encodedPayloadBits = await LDPC.encode(payloadBitArray.toArray(), errorCorrectionLength);
        for (let i=0; i<encodedPayload.length; ++i) {
            encodedPayload.setValue(i, encodedPayloadBits[i]);
        }
        const hexRingMasks = this._maskHexagonRings(hexRingMaskCount, encodedPayload);
        await NimiqodeHeader.write(header, version, payloadBitArray.length, errorCorrectionLength, checksum,
            hexRingMasks);
        Nimiqode.assignHexagonRingData(this._hexagonRings, this._data);
        return this;
    }

    async _constructFromScan(hexagonRings, data) {
        this._hexagonRings = hexagonRings;
        this._data = data;
        const hexRingMaskCount = NimiqodeHeader.calculateMaskCount(hexagonRings);
        const headerLength = NimiqodeHeader.calculateLength(hexRingMaskCount);
        const header = new BitArray(this._data, 0, headerLength);
        const [version, payloadLength, errorCorrectionLength, checksum, hexRingMasks] =
            await NimiqodeHeader.read(header, hexagonRings);
        if (version !== 0) {
            throw Error('Illegal nimiqode: Unsupported version.');
        }
        if (headerLength + payloadLength + errorCorrectionLength !== data.length) {
            throw Error('Illegal nimiqode: Wrong data length.'); // Probably recognized wrong number of hexagon rings.
        }
        // unmask the payload
        const encodedPayload = new BitArray(this._data, headerLength, this._data.length, true); // a copy
        this._maskHexagonRings(hexRingMasks, encodedPayload); // unmask by applying the mask again
        // decode the payload
        let payloadBits;
        try {
            payloadBits = await LDPC.decode(encodedPayload.toArray(), payloadLength, errorCorrectionLength);
        } catch(e) {
            throw Error('Illegal nimiqode: Failed to decode payload.');
        }
        this._payload = new Uint8Array(payloadLength / 8); // in byte
        const payloadBitArray = new BitArray(this._payload);
        for (let i=0; i<payloadLength; ++i) {
            payloadBitArray.setValue(i, payloadBits[i]);
        }
        if (CRC16.crc16(this._payload) !== checksum) {
            throw Error('Illegal nimiqode: Checksum mismatch.');
        }
        return this;
    }

    get payload() {
        return this._payload;
    }

    get hexagonRings() {
        return this._hexagonRings;
    }

    static calculateLength(hexRings, lengthPayload, lengthErrorCorrection) {
        const hexRingMaskCount = NimiqodeHeader.calculateMaskCount(hexRings);
        return NimiqodeHeader.calculateLength(hexRingMaskCount) + lengthPayload + lengthErrorCorrection;
    }

    static createHexagonRing(index) {
        // Index 0 is the innermost ring.
        // All the rings have the counterclockwise and clockwise finder pattern set, just the innermost ring has the
        // clockwise finder pattern unset.
        return new HexagonRing(NimiqodeSpecification.HEXRING_INNERMOST_RADIUS
            + index * NimiqodeSpecification.HEXRING_RING_DISTANCE, NimiqodeSpecification.HEXRING_BORDER_RADIUS,
            NimiqodeSpecification.HEXRING_START_END_OFFSET, NimiqodeSpecification.HEXRING_SLOT_DISTANCE,
            NimiqodeSpecification.HEXRING_SLOT_LENGTH, index===0?
                NimiqodeSpecification.HEXRING_FINDER_PATTERN_LENGTH_UNSET :
                NimiqodeSpecification.HEXRING_FINDER_PATTERN_LENGTH_SET,
            NimiqodeSpecification.HEXRING_FINDER_PATTERN_LENGTH_SET, index!==0, true);
    }

    _createHexagonRings(payloadLength, errorCorrectionLength) {
        let totalBits = 0;
        let hexagonRingCount = 0;
        do {
            const hexRing = Nimiqode.createHexagonRing(hexagonRingCount);
            this._hexagonRings.push(hexRing);
            totalBits += hexRing.bitCount;
            ++hexagonRingCount;
        } while (totalBits < Nimiqode.calculateLength(this._hexagonRings, payloadLength, errorCorrectionLength)
            || hexagonRingCount < 2); // have at least 2 hexagon rings as single rings can't be decoded
        return totalBits;
    }

    static assignHexagonRingData(hexagonRings, data) {
        let handledBits = 0;
        for (const hexRing of hexagonRings) {
            hexRing.data = new BitArray(data, handledBits, handledBits + hexRing.bitCount);
            handledBits += hexRing.bitCount;
        }
    }


    _maskHexagonRings(maskCountOrMasks, dataToMask) {
        // mask the data assigned to the hex rings
        const masks = [];
        const givenMasks = Array.isArray(maskCountOrMasks)? maskCountOrMasks : null;
        const maskCount = givenMasks? givenMasks.length : maskCountOrMasks;
        let hexRingEnd = dataToMask.length;
        for (let i=0; i<maskCount; ++i) {
            const hexRing = this._hexagonRings[this._hexagonRings.length - i - 1];
            const hexRingDataToMask = new BitArray(dataToMask, Math.max(0, hexRingEnd - hexRing.bitCount), hexRingEnd);
            const mask = givenMasks? givenMasks[givenMasks.length - i - 1] : Masking.findBestMask(hexRingDataToMask);
            Masking.applyMask(mask, hexRingDataToMask);
            hexRingEnd -= hexRingDataToMask.length;
            masks.unshift(mask);
        }
        return masks;
    }
}