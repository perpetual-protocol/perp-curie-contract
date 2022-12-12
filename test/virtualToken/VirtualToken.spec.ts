import { expect } from "chai"
import { ethers, waffle } from "hardhat"
import { BaseToken } from "../../typechain"
import { createBaseTokenFixture } from "../shared/fixtures"

describe("VirtualToken Spec", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let baseToken: BaseToken

    beforeEach(async () => {
        const _fixture = await loadFixture(createBaseTokenFixture())
        baseToken = _fixture.baseToken
    })

    describe("onlyOwner setters", () => {
        it("force error, addWhitelist only for owner", async () => {
            await expect(baseToken.connect(alice).addWhitelist(bob.address)).to.be.revertedWith("SO_CNO")
        })

        it("force error, removeWhitelist only for owner", async () => {
            await expect(baseToken.connect(alice).removeWhitelist(bob.address)).to.be.revertedWith("SO_CNO")
        })

        it("force error, mintMaximumTo only for owner", async () => {
            await expect(baseToken.connect(alice).mintMaximumTo(bob.address)).to.be.revertedWith("SO_CNO")
        })
    })

    describe("# mintMaximumTo", () => {
        it("should mint maximum amount of tokens to a given address", async () => {
            await baseToken.addWhitelist(alice.address)
            await baseToken.mintMaximumTo(alice.address)
            const balance = await baseToken.balanceOf(alice.address)
            expect(balance).to.be.eq(ethers.constants.MaxUint256)
        })
    })

    describe("# addWhitelist", () => {
        it("add to white list", async () => {
            await baseToken.addWhitelist(alice.address)
            expect(await baseToken.isInWhitelist(alice.address)).to.be.true
        })
    })

    describe("# removeWhitelist", () => {
        beforeEach(async () => {
            // mint
            await baseToken.addWhitelist(alice.address)
            await baseToken.mintMaximumTo(alice.address)
        })

        it("remove from white list", async () => {
            await baseToken.addWhitelist(bob.address)
            await baseToken.connect(admin).removeWhitelist(bob.address)
            expect(await baseToken.isInWhitelist(bob.address)).to.be.false
        })

        it("force error, can not remove address in white list if balance is not zero", async () => {
            await expect(baseToken.connect(admin).removeWhitelist(alice.address)).to.be.revertedWith("VT_BNZ")
        })
    })
})
