import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { TestERC20, Vault } from "../../typechain"
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
        const amount = parseUnits("1000", await usdc.decimals())
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)
    })

    describe("decimals", () => {
        it("equals to settlement token's decimal")
    })

    describe("admin only simple setter", () => {
        it("setClearingHouse")
        it("setCloseFactor")
        it("setLiquidationIncentive")
        it("setLiquidationOrder")
        it("force error by non-admin")
    })

    describe.skip("setLiquidationOrder", () => {
        it("updated liquidationOrder")
        it("force error, the numbers of asset did not match")
        it("force error by non-admin")
    })

    describe.skip("addCollateral", () => {
        it("add an ERC20 with totalWeight, initWeight and IMF-Factor")
        it("force error, none of the input can be 0")
        it("can't add native ETH")
        it("can't add existed collateral")
        it("force error, ERC20 without decimals")
        it("force error by non-admin")
    })

    describe.skip("isCollateral", () => {})

    describe("deposit", () => {
        // @SAMPLE - deposit
        it("sends event", async () => {
            const amount = parseUnits("100", await usdc.decimals())

            // check event has been sent
            await expect(vault.connect(alice).deposit(alice.address, usdc.address, amount))
                .to.emit(vault, "Deposited")
                .withArgs(usdc.address, alice.address, amount)

            // reduce alice balance
            expect(await usdc.balanceOf(alice.address)).to.eq(parseUnits("900", await usdc.decimals()))

            // increase vault balance
            expect(await usdc.balanceOf(vault.address)).to.eq(parseUnits("100", await usdc.decimals()))

            // update sender's balance
            expect(await vault.balanceOf(alice.address)).to.eq(parseUnits("100", await usdc.decimals()))
        })

        it.skip("non-standard ERC20 (USDT) is supported")

        it("can't add collateral not supported")
    })

    describe("getFreeCollateral", () => {
        it("equals to total collateral value + locked collateral value (0)")
        it("equals to total collateral value + locked collateral value ( > 0)")
        it("force error, clearingHouse not found")
    })

    describe("withdraw settlement token", () => {
        it("reduce vault's token balance")
        it("increase sender's token balance")
        it("update ClearingHouse's quote debt to 0")
        it("force error if the freeCollateral is not enough")

        describe("USDC collateral is not enough", () => {
            it("borrow from insuranceFund, increase usdcDebt")
        })
    })

    describe.skip("withdraw non-settlement token", () => {
        it("reduce vault's token balance")
        it("increase sender's token balance")
        it("force error if the freeCollateral is not enough")
    })

    // TODO not sure if this is needed
    describe("balanceOf", () => {
        it("is zero by default", async () => {
            expect(await vault.balanceOf(alice.address)).eq(0)
        })

        it("equals to USDC balance if it's the only collateral")
        it("equals multi collateral's USDC value")
    })

    describe.skip("liquidate", () => {
        it("force error, close more than maxCloseFactor")
        it("force error, close less than minCloseFactor")
        it("force error, liquidator can't be the same as the position owner")
        describe("no bad debt", () => {
            it("reduce USDC balance")
            it("increase liquidation asset, WETH")
            it("get cheaper WETH compare to UniswapV3 TWAP")
        })

        describe("has bad debt", () => {
            it("reduce USDC balance")
            it("increase liquidation asset, WETH")
            it("get cheaper WETH compare to UniswapV3 TWAP")
            it("reduce usdcDebt if usdc debt > bad debt")
            it("reduce usdcDebt to 0 if usdc debt <= bad debt, insurance fund cover extra bad debt")
            it("insurance fund cover full bad debt when usdcDebt is 0")
        })
    })
})
