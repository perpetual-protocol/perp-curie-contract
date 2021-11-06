import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { createClearingHouseFixture } from "../clearingHouse/fixtures"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let clearingHouse: ClearingHouse
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance
    let exchange: Exchange
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(false))
        vault = _fixture.vault
        usdc = _fixture.USDC
        clearingHouse = _fixture.clearingHouse
        insuranceFund = _fixture.insuranceFund
        accountBalance = _fixture.accountBalance
        exchange = _fixture.exchange
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedBaseAggregator = _fixture.mockedBaseAggregator

        usdcDecimals = await usdc.decimals()

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)
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
            useTakerPosition: false,
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
            expect(await vault.getBalance(alice.address)).to.eq("0")
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

                expect(await vault.getTotalDebt()).to.eq(borrowedAmount)
                expect(await usdc.balanceOf(vault.address)).to.eq("0")
                expect(await usdc.balanceOf(insuranceFund.address)).to.eq(parseUnits("80", usdcDecimals))
            })
        })
    })

    describe("freeCollateral should include funding payment", () => {
        beforeEach(async () => {
            const amount = parseUnits("100", usdcDecimals)
            await vault.connect(alice).deposit(usdc.address, amount)
        })

        it("long then get free collateral", async () => {
            // set index price for a positive funding
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("150", 6), 0, 0, 0]
            })

            // alice long 0.065379992856491801 ETH for 10 USD
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // openNotional = -10
            // positionValue = 0.065379992856491801 * 150 = 9.8069989285
            // unrealizedPnL = 9.8069989285 -10 = -0.1930010715
            // freeCollateral = min(collateral, accountValue) - totalDebt * imRatio
            //                = min(100, 100-0.1930010715) - 10*0.1
            //                = 98.806998

            await forward(3600)

            // alice should pay funding payment
            // note that bob will settle his pending funding payment here

            // fundingPayment = positionSize * pricePremium * 3600 / (24 * 3600)
            //                = 0.065379992856491801 * (151.4641535519 - 150) * 3600 / (24 * 3600)
            //                = 0.00398859786
            // freeCollateral = 98.806998 - 0.00398859786
            //                = 98.803009

            const freeCollateral = (await vault.getFreeCollateral(alice.address)).toString()
            expect(freeCollateral).to.be.eq(parseUnits("98.803011", usdcDecimals))
        })
    })
})
