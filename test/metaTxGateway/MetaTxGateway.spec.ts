import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signers"
import { expect } from "chai"
import { loadFixture } from "ethereum-waffle"
import { ethers } from "hardhat"
import { MetaTxGateway, TestMetaTxRecipient } from "../../typechain"
import { EIP712Domain, signEIP712MetaTx } from "../helper/eip712"
import { createMetaTxGatewayFixture } from "./fixtures"

describe("MetaTxGateway Spec", () => {
    let alice: SignerWithAddress
    let relayer: SignerWithAddress
    const l1ChainId = 1

    let metaTxGateway: MetaTxGateway
    let domain: EIP712Domain
    let metaTxGatewayRecipient: TestMetaTxRecipient

    beforeEach(async () => {
        const signers = await ethers.getSigners()
        alice = signers[1]
        relayer = signers[2]

        const _metaTxGatewayFixture = await loadFixture(createMetaTxGatewayFixture())
        metaTxGateway = _metaTxGatewayFixture.metaTxGateway
        metaTxGatewayRecipient = _metaTxGatewayFixture.metaTxRecipient

        await metaTxGateway.addToWhitelists(metaTxGatewayRecipient.address)

        domain = {
            name: "Test",
            version: "1",
            chainId: l1ChainId,
            verifyingContract: metaTxGateway.address,
        }
    })

    it("Meta tx signed on L1", async () => {
        expect(await metaTxGatewayRecipient.pokedBy()).to.eq("0x0000000000000000000000000000000000000000")

        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }

        const signedResponse = await signEIP712MetaTx(alice, domain, metaTx)
        await metaTxGateway
            .connect(relayer)
            .executeMetaTransaction(
                metaTx.from,
                metaTx.to,
                metaTx.functionSignature,
                signedResponse.r,
                signedResponse.s,
                signedResponse.v,
            )

        expect(await metaTxGatewayRecipient.pokedBy()).to.eq(alice.address)
    })

    it("Meta tx signed on L2", async () => {
        expect(await metaTxGatewayRecipient.pokedBy()).to.eq("0x0000000000000000000000000000000000000000")

        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(
            alice,
            {
                ...domain,
                chainId: 31337, // default hardhat evm chain ID
            },
            metaTx,
        )

        await metaTxGateway
            .connect(relayer)
            .executeMetaTransaction(
                metaTx.from,
                metaTx.to,
                metaTx.functionSignature,
                signedResponse.r,
                signedResponse.s,
                signedResponse.v,
            )

        expect(await metaTxGatewayRecipient.pokedBy()).to.eq(alice.address)
    })

    it("force error, the target contract is not whitelisted", async () => {
        const metaTx = {
            from: alice.address,
            to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", // arbitrary address not in whitelist
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(alice, domain, metaTx)

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("!whitelisted")
    })

    it("force error, only owner can add whitelisting", async () => {
        await expect(
            metaTxGateway.connect(alice).addToWhitelists("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"),
        ).to.be.revertedWith("Ownable: caller is not the owner")
    })

    it("force error, incorrect domain info", async () => {
        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(
            alice,
            {
                ...domain,
                version: "2", // wrong domain version
            },
            metaTx,
        )

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("Signer and signature do not match")
    })

    it("force error, the nonce is too high", async () => {
        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: 1, // nonce should be 0 instead of 1
        }
        const signedResponse = await signEIP712MetaTx(alice, domain, metaTx)

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("Signer and signature do not match")
    })

    it("force error, the nonce is too low", async () => {
        // make a successful meta tx first
        const metaTx1 = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse1 = await signEIP712MetaTx(alice, domain, metaTx1)
        await metaTxGateway
            .connect(relayer)
            .executeMetaTransaction(
                metaTx1.from,
                metaTx1.to,
                metaTx1.functionSignature,
                signedResponse1.r,
                signedResponse1.s,
                signedResponse1.v,
            )
        expect(await metaTxGateway.getNonce(alice.address)).to.eq("1")

        // make the second meta tx
        const metaTx2 = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: 0, // nonce should be 1 instead of 0
        }
        const signedResponse2 = await signEIP712MetaTx(alice, domain, metaTx2)
        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx2.from,
                    metaTx2.to,
                    metaTx2.functionSignature,
                    signedResponse2.r,
                    signedResponse2.s,
                    signedResponse2.v,
                ),
        ).to.be.revertedWith("Signer and signature do not match")
    })

    it("force error, `from` in the meta tx is different from the signer", async () => {
        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(
            relayer, // sign the meta tx with other account
            {
                name: "Test",
                version: "1",
                chainId: l1ChainId,
                verifyingContract: metaTxGateway.address,
            },
            metaTx,
        )

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("Signer and signature do not match")
    })

    it("force error, `from` in meta tx in zero address", async () => {
        const metaTx = {
            from: "0x0000000000000000000000000000000000000000",
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: 0,
        }
        const invalidSignature =
            "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefde"
        const signedResponse = {
            invalidSignature,
            r: "0x" + invalidSignature.substring(0, 64),
            s: "0x" + invalidSignature.substring(64, 128),
            v: parseInt(invalidSignature.substring(128, 130), 16),
        }

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("invalid signature")
    })

    it("verify the reverted message", async () => {
        await expect(metaTxGatewayRecipient.error()).to.be.revertedWith("MetaTxRecipientMock: Error")

        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("error()"),
            nonce: +(await metaTxGateway.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(
            alice,
            {
                ...domain,
                chainId: 31337, // default hardhat evm chain ID
            },
            metaTx,
        )

        await expect(
            metaTxGateway
                .connect(relayer)
                .executeMetaTransaction(
                    metaTx.from,
                    metaTx.to,
                    metaTx.functionSignature,
                    signedResponse.r,
                    signedResponse.s,
                    signedResponse.v,
                ),
        ).to.be.revertedWith("MetaTxRecipientMock: Error")
    })

    it("the target contract is called by a non trusted forwarder", async () => {
        expect(await metaTxGatewayRecipient.pokedBy()).to.eq("0x0000000000000000000000000000000000000000")

        // create another forwarder which is not trusted by metaTxRecipient
        const fixture = createMetaTxGatewayFixture()
        const nonTrustedForwarder = (await fixture()).metaTxGateway
        expect(await metaTxGatewayRecipient.isTrustedForwarder(nonTrustedForwarder.address)).to.be.false
        await nonTrustedForwarder.addToWhitelists(metaTxGatewayRecipient.address)

        const metaTx = {
            from: alice.address,
            to: metaTxGatewayRecipient.address,
            functionSignature: metaTxGatewayRecipient.interface.getSighash("poke()"),
            nonce: +(await nonTrustedForwarder.getNonce(alice.address)),
        }
        const signedResponse = await signEIP712MetaTx(
            alice,
            {
                ...domain,
                verifyingContract: nonTrustedForwarder.address, // use the non-trusted forwarder
            },
            metaTx,
        )

        // send meta tx through the non-trusted forwarder
        await nonTrustedForwarder
            .connect(relayer)
            .executeMetaTransaction(
                metaTx.from,
                metaTx.to,
                metaTx.functionSignature,
                signedResponse.r,
                signedResponse.s,
                signedResponse.v,
            )

        // _msgSender() should fallback to msg.sender, which is the non-trusted forwarder
        expect(await metaTxGatewayRecipient.pokedBy()).to.eq(nonTrustedForwarder.address)
    })
})
