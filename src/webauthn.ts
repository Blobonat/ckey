import * as CBOR from 'cbor';

import {getCompatibleKey, getCompatibleKeyFromCryptoKey} from './crypto';

import {getLogger} from './logging';

import {fetchKey, keyExists, saveKey} from './storage';

import {base64ToByteArray, byteArrayToBase64, getDomainFromOrigin} from './utils';

import {BackupKey, createPSKSetupExtensionOutput, PSK, recover} from './recovery';

const log = getLogger('webauthn');

// Attestation
export const processCredentialCreation = async (
    origin: string,
    publicKeyCreationOptions: PublicKeyCredentialCreationOptions,
    pin: string,
): Promise<PublicKeyCredential> => {
    if (publicKeyCreationOptions.attestation !== 'none') {
        log.warn('We can perform only none attestation');
        return null;
    }

    let supportRecovery = false;
    const reqExt: any = publicKeyCreationOptions.extensions;
    if (reqExt !== undefined) {
        if (reqExt.hasOwnProperty(PSK)) {
            supportRecovery = true;
            log.info('RP supports PSK');
        }
    }

    const rp = publicKeyCreationOptions.rp;
    const rpID = rp.id || getDomainFromOrigin(origin);

    const bckpKey = await BackupKey.get();
    log.info('Use backup key', bckpKey);

    const credId = base64ToByteArray(bckpKey.id, true);
    const encCredId = byteArrayToBase64(credId, true);

    if (await keyExists(encCredId)) {
        throw new Error(`credential with id ${encCredId} already exists`);
    }

    const compatibleKey = await getCompatibleKey(publicKeyCreationOptions.pubKeyCredParams);

    let extOutput = null;
    if (supportRecovery) {
        extOutput = await createPSKSetupExtensionOutput(bckpKey);
    }
    const authenticatorData = await compatibleKey.generateAuthenticatorData(rpID, 0, credId, extOutput);

    const clientData = await compatibleKey.generateClientData(
        publicKeyCreationOptions.challenge as ArrayBuffer,
        { origin, type: 'webauthn.create' },
    );

    const attestationObject = CBOR.encodeCanonical({
        attStmt: new Map(),
        authData: authenticatorData,
        fmt: 'none',
    }).buffer;

    await saveKey(encCredId, compatibleKey.privateKey, pin);

    log.debug('Attestation created');

    return {
        getClientExtensionResults: () => ({}),
        id: encCredId,
        rawId: credId,
        response: {
            attestationObject,
            clientDataJSON: base64ToByteArray(window.btoa(clientData)),
        },
        type: 'public-key',
    } as PublicKeyCredential;
};

// Assertion
export const processCredentialRequest = async (
    origin: string,
    publicKeyRequestOptions: PublicKeyCredentialRequestOptions,
    pin: string,
): Promise<Credential> => {
    if (!publicKeyRequestOptions.allowCredentials) {
        log.debug('No credentials requested');
        return null;
    }

    const reqExt: any = publicKeyRequestOptions.extensions;
    if (reqExt !== undefined) {
        if (reqExt.hasOwnProperty(PSK)) {
            log.debug('Recovery requested');
            return await recover(origin, publicKeyRequestOptions, pin);
        }
    }

    let i;
    let key;
    let credId: ArrayBuffer;
    let encCredId;
    for (i = 0; i < publicKeyRequestOptions.allowCredentials.length; i++) {
        const requestedCredential = publicKeyRequestOptions.allowCredentials[i];
        credId = requestedCredential.id as ArrayBuffer;
        encCredId = byteArrayToBase64(new Uint8Array(credId), true);

        key = await fetchKey(encCredId, pin).catch((_) => null);

        if (key) {
            break;
        }
    }
    if (!key) {
        throw new Error(`credential with id ${JSON.stringify(publicKeyRequestOptions.allowCredentials)} not found`);
    }

    const rpID = publicKeyRequestOptions.rpId || getDomainFromOrigin(origin);

    const compatibleKey = await getCompatibleKeyFromCryptoKey(key);
    const clientData = await compatibleKey.generateClientData(
        publicKeyRequestOptions.challenge as ArrayBuffer,
        {
            origin,
            tokenBinding: {
                status: 'not-supported',
            },
            type: 'webauthn.get',
        },
    );
    const clientDataJSON = base64ToByteArray(window.btoa(clientData));
    const clientDataHash = new Uint8Array(await window.crypto.subtle.digest('SHA-256', clientDataJSON));

    const authenticatorData = await compatibleKey.generateAuthenticatorData(rpID, 0, new Uint8Array(), null);

    // Prepare input for signature
    const concatData = new Uint8Array(authenticatorData.length + clientDataHash.length);
    concatData.set(authenticatorData);
    concatData.set(clientDataHash, authenticatorData.length);

    const signature = await compatibleKey.sign(concatData);
    log.debug('signature', signature);
    log.debug('clientData', clientData);

    return {
        getClientExtensionResults: () => ({}),
        id: encCredId,
        rawId: credId,
        response: {
            authenticatorData: authenticatorData.buffer,
            clientDataJSON,
            signature: (new Uint8Array(signature)).buffer,
            userHandle: new ArrayBuffer(0),
        },
        type: 'public-key',
    } as PublicKeyCredential;
};
