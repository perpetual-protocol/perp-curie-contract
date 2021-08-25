import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers"

export interface EIP712Domain {
    name: string
    version: string
    chainId: number
    verifyingContract: string
}

export interface MetaTx {
    from: string
    to: string
    functionSignature: string
    nonce: number
}

export interface SignedResponse {
    signature: string
    r: string
    s: string
    v: number
}

const EIP712DomainTypes = [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
]

const MetaTxTypes = [
    { name: "nonce", type: "uint256" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "functionSignature", type: "bytes" },
]

export async function signEIP712MetaTx(
    signer: SignerWithAddress,
    domain: EIP712Domain,
    metaTx: MetaTx,
): Promise<SignedResponse> {
    const dataToSign = {
        types: {
            MetaTransaction: MetaTxTypes,
        },
        domain,
        primaryType: "MetaTransaction",
        message: metaTx,
    }

    const sign = await signer._signTypedData(domain, dataToSign.types, metaTx)
    const signature = sign.substring(2)
    return {
        signature,
        r: "0x" + signature.substring(0, 64),
        s: "0x" + signature.substring(64, 128),
        v: parseInt(signature.substring(128, 130), 16),
    }
}
