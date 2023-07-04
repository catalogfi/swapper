import * as bitcoin from "bitcoinjs-lib";
import { fromBase58Check } from "bitcoinjs-lib/src/address";

export const buildRedeemScript = (
    secretHash: string,
    redeemerAddress: string,
    initiatorAddress: string,
    expiry: number,
    network: bitcoin.Network
) => {
    const redeemScript = bitcoin.script.fromASM(
        `
        OP_IF
            OP_SHA256
            ${secretHash}
            OP_EQUALVERIFY
            OP_DUP
            OP_HASH160
            ${fromBase58Check(redeemerAddress).hash.toString("hex")}
            OP_EQUALVERIFY
            OP_CHECKSIG
        OP_ELSE
            ${expiry}
            OP_CHECKSEQUENCEVERIFY
            OP_DROP
            OP_DUP
            OP_HASH160
            ${fromBase58Check(initiatorAddress).hash.toString("hex")}
            OP_EQUALVERIFY
            OP_CHECKSIG
        OP_ENDIF
    `
            .trim()
            .replace(/\s+/g, " ")
    );
    const p2sh = bitcoin.payments.p2sh({
        redeem: {
            output: redeemScript,
        },
        network,
    });
    if (!p2sh.address) throw new Error("Could not build address");
    return {
        redeemScript,
        address: p2sh.address,
    };
};
