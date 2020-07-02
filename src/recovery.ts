import {getLogger} from "./logging";
import {base64ToByteArray} from "./utils";
import {keyExportFormat} from "./constants";

const log = getLogger('recovery');

export async function syncBackupKeys () {
    const bckpKeys = await loadBackupKeys();
    log.info("Loaded backup keys", bckpKeys);
    await storeBackupKeys("backup", bckpKeys)
}

export class BackupKey {
    key: CryptoKey;
    id: string;
    constructor(key: CryptoKey, id: string) {
        this.key = key;
        this.id = id;
    }
}

export async function loadBackupKeys(): Promise<Array<BackupKey>> {
    log.info("Loading backup keys form JSON file")
    return new Promise<Array<BackupKey>>(function (resolve, reject) {
        let xhr = new XMLHttpRequest();
        xhr.open("GET", chrome.extension.getURL('/recovery/backup.json'), true);
        xhr.onload = function () {
            let status = xhr.status;
            if (status == 200) {
                let jwk = JSON.parse(this.response);
                let i;
                let bckpKeys = new Array<BackupKey>()
                for (i = 0; i < jwk.length; ++i) {
                    bckpKeys.push(new BackupKey(jwk[i], jwk[i].kid));
                }
                resolve(bckpKeys);
            } else {
                reject(status);
            }
        };
        xhr.send();
    });
}

async function parseKey(jwk): Promise<CryptoKey> {
    return window.crypto.subtle.importKey(
        "jwk",
        jwk,
        {
            name: "ECDSA",
            namedCurve: "P-256"
        },
        true,
        []
    );
}

async function storeBackupKeys(identifier: string, backupKeys: Array<BackupKey>): Promise<void> {
    log.info("Storing backup keys")
    let bckpJSON = await JSON.stringify(backupKeys);
    return new Promise<void>(async (res, rej) => {
        chrome.storage.sync.set({ [identifier]: bckpJSON }, () => {
            if (!!chrome.runtime.lastError) {
                log.info("Backup keys not stored")
                rej(chrome.runtime.lastError);
            } else {
                log.info("Backup keys stored")
                res();
            }
        });
    });
}

async function fetchBackupKeys(identifier: string): Promise<Array<BackupKey>> {
        return new Promise<Array<BackupKey>>(async (res, rej) => {
            chrome.storage.sync.get(identifier, async (resp) => {
                if (!!chrome.runtime.lastError) {
                    log.info("Could not fetch backup keys");
                    rej(chrome.runtime.lastError);
                    return;
                }
                let bckpKeys = await JSON.parse(resp[identifier]);
                log.info(bckpKeys);
                res(bckpKeys);
            });
        });
}

export async function popBackupKey(identifier: string = "backup"): Promise<BackupKey> {
    let bckpKeys = await fetchBackupKeys(identifier);
    let key = bckpKeys.pop();
    await storeBackupKeys(identifier, bckpKeys)
    return key;
}