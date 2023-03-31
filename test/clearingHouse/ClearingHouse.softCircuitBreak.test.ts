import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    InsuranceFund,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { getMaxTickRange, priceToTick } from "../helper/number"
import { mintAndDeposit } from "../helper/token"
import { initiateBothTimestamps } from "../shared/time"
import { mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse softCircuitBreak", () => {
    const [admin, , bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let accountBalance: TestAccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher2: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(
            createClearingHouseFixture(
                true,
                10000, // 1%
            ),
        )
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        mockedPriceFeedDispatcher2 = fixture.mockedPriceFeedDispatcher2
        collateralDecimals = await collateral.decimals()

        // initialize ETH pool
        await initMarket(fixture, "1000", 10000, 0, getMaxTickRange(), baseToken.address)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // mint collateral
        await mintAndDeposit(fixture, bob, 150)
        await mintAndDeposit(fixture, carol, 20000000)

        // carol adds liquidity
        const pool1TickSpacing = await pool.tickSpacing()
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100000"),
            quote: parseEther("10000000"),
            lowerTick: priceToTick(700, pool1TickSpacing),
            upperTick: priceToTick(1300, pool1TickSpacing),
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    describe("liquidation in different insuranceFund capacity case", () => {
        beforeEach(async () => {
            // bob longs ETH
            // quote: -1000
            // base: 0.989984344318166945
            await q2bExactInput(fixture, bob, 1000, baseToken.address)

            // mint & deposit usdc to davis
            await mintAndDeposit(fixture, davis, 10000)
        })

        it("trader has positive accountValue after liquidation", async () => {
            await mockMarkPrice(accountBalance, baseToken.address, "900")

            // after liquidation, trader's accountValue: 29.847554
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
            ).emit(clearingHouse, "PositionLiquidated")
        })

        it("trader has negative accountValue but insuranceFund capacity can cover that", async () => {
            await mockMarkPrice(accountBalance, baseToken.address, "800")

            // mint usdc to insuranceFund wallet
            await collateral.mint(insuranceFund.address, parseUnits("100", 6))
            const ifCapacityBefore = await insuranceFund.getInsuranceFundCapacity()

            // after liquidation, trader's accountValue: -77.813129
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
            ).emit(clearingHouse, "PositionLiquidated")

            const accountValue = await clearingHouse.getAccountValue(bob.address)
            expect(accountValue).to.be.eq("0")
            const ifCapacityAfter = await insuranceFund.getInsuranceFundCapacity()
            expect(ifCapacityAfter).to.be.lt(ifCapacityBefore)
        })

        it("trader has negative accountValue but insuranceFund capacity can't cover that", async () => {
            await mockMarkPrice(accountBalance, baseToken.address, "800")

            // mint usdc to insuranceFund wallet
            await collateral.mint(insuranceFund.address, parseUnits("30", 6))

            // after liquidation, trader's accountValue: -77.813129
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
            ).revertedWith("CH_IIC")
        })

        // TODO: might implement this logic on periphery contract
        it.skip("calculate liquidatable amount depend on insuranceFund capacity", async () => {})
    })
})
