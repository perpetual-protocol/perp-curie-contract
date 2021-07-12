import { expect } from "chai"
import { waffle } from "hardhat"
import { TestERC20, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { createVaultFixture } from "./fixtures"

describe("Vault spec", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20

    beforeEach(async () => {
        const _fixture = await loadFixture(createVaultFixture())
        vault = _fixture.vault
        usdc = _fixture.USDC

        // mint
        const amount = toWei(1000, await usdc.decimals())
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)
    })

    describe("decimals", () => {
        it("equals to settlement token's decimal")
    })

    describe("deposit", () => {
        // @SAMPLE - deposit
        it("sends event", async () => {
            const amount = toWei(100, await usdc.decimals())

            // check event has been sent
            await expect(vault.connect(alice).deposit(alice.address, usdc.address, amount))
                .to.emit(vault, "Deposited")
                .withArgs(usdc.address, alice.address, amount)

            // reduce alice balance
            expect(await usdc.balanceOf(alice.address)).to.eq(toWei(900, await usdc.decimals()))

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(toWei(100, await usdc.decimals()))

            // update sender's balance
            expect(await vault.balanceOf(alice.address)).to.eq(toWei(100, await usdc.decimals()))
        })

        it("can't add token not supported")
    })

    describe("getFreeCollateral")

    describe("balanceOf", () => {
        it("is zero by default", async () => {
            expect(await vault.balanceOf(alice.address)).eq(0)
        })

        it("equals multi collateral's USDC value")
    })

    describe("withdraw", () => {
        it("reduce vault's token balance")
        it("increase sender's token balance")
        it("force error if the freeCollateral is not enough")
    })

    describe("addCollateral", () => {
        it("only by admin")
        it("can't add existed collateral")
    })

    describe("realizeProfit", () => {
        it("only by ClearingHouse")
        it("increase account's balance")
    })

    describe("realizeLoss", () => {
        it("only by ClearingHouse")

        describe("over collateral", () => {
            it("decrease account's settlement token balance")
            it("loss all settlement token and part of other collateral")
        })

        describe("under collateral", () => {
            it("loss all settlement token and part of other collateral")
            it("loss all collateral and occurs bad debt")
        })
    })

    describe("setClearingHouse", () => {
        it("only by admin")
    })
})
