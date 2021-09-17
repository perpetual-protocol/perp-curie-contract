import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    InsuranceFund,
    MarketRegistry,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { createClearingHouseFixture } from "../clearingHouse/fixtures"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let clearingHouse: ClearingHouse
    let insuranceFund: InsuranceFund
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture())
        vault = _fixture.vault
        usdc = _fixture.USDC
        clearingHouse = _fixture.clearingHouse
        insuranceFund = _fixture.insuranceFund
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedBaseAggregator = _fixture.mockedBaseAggregator

        usdcDecimals = await usdc.decimals()

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        await marketRegistry.addPool(baseToken.address, 10000)
        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        await usdc.mint(bob.address, parseUnits("10000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await clearingHouse.connect(bob).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("200"),
            quote: parseEther("100000"),
            lowerTick: 0,
            upperTick: 150000,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    })

    describe("withdraw settlement token", async () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            amount = parseUnits("100", usdcDecimals)
            await vault.connect(alice).deposit(usdc.address, amount)
        })

        it("emit event and update balances", async () => {
            const aliceBalanceBefore = await usdc.balanceOf(alice.address)
            const vaultBalanceBefore = await usdc.balanceOf(vault.address)

            await expect(vault.connect(alice).withdraw(usdc.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, amount)

            // decrease vault's token balance
            const vaultBalanceAfter = await usdc.balanceOf(vault.address)
            expect(vaultBalanceBefore.sub(vaultBalanceAfter)).to.eq(amount)

            // sender's token balance increased
            const aliceBalanceAfter = await usdc.balanceOf(alice.address)
            expect(aliceBalanceAfter.sub(aliceBalanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.balanceOf(alice.address)).to.eq("0")
        })

        it("force error if the freeCollateral is not enough", async () => {
            // alice open a position so free collateral is not enough
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("50"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await expect(vault.connect(alice).withdraw(usdc.address, amount)).to.be.revertedWith("V_NEFC")
        })

        describe("USDC collateral is not enough", () => {
            it("borrow from insuranceFund", async () => {
                await usdc.mint(insuranceFund.address, parseUnits("100", usdcDecimals))

                const borrowedAmount = parseUnits("20", usdcDecimals)

                // burn vault's balance to make it not enough to pay when withdrawing
                const vaultBalance = await usdc.balanceOf(vault.address)
                await usdc.burnWithoutApproval(vault.address, vaultBalance.sub(parseUnits("80", usdcDecimals)))

                // need to borrow 20 USDC from insuranceFund
                await expect(vault.connect(alice).withdraw(usdc.address, amount))
                    .to.emit(insuranceFund, "Borrowed")
                    .withArgs(vault.address, borrowedAmount)
                    .to.emit(vault, "Withdrawn")
                    .withArgs(usdc.address, alice.address, amount)

                expect(await vault.totalDebt()).to.eq(borrowedAmount)
                expect(await usdc.balanceOf(vault.address)).to.eq("0")
                expect(await usdc.balanceOf(insuranceFund.address)).to.eq(parseUnits("80", usdcDecimals))
            })
        })
    })
})
