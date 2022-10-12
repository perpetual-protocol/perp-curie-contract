import { MockContract } from "@eth-optimism/smock"
import bn from "bignumber.js"
import { expect } from "chai"
import { BigNumberish, Wallet } from "ethers"
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
import { calculateLiquidatePositionSize, getMarginRatio, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse softCircuitBreak", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
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
    let baseToken2: BaseToken
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let collateralDecimals: number
    const oracleDecimals = 6
    const blockTimeStamp = 1

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    async function _getMarginRatio(trader: Wallet) {
        const accountValue = await clearingHouse.getAccountValue(trader.address)
        const totalPositionValue = await accountBalance.getTotalAbsPositionValue(trader.address)
        const marginRatio = accountValue.lte(0) ? new bn(0) : getMarginRatio(accountValue, totalPositionValue)

        return marginRatio
    }

    async function _calculateLiquidatePositionSize(trader: Wallet, baseToken: BaseToken) {
        const positionSize = await accountBalance.getTakerPositionSize(trader.address, baseToken.address)
        const totalAbsPositionValue = await accountBalance.getTotalAbsPositionValue(trader.address)
        const absPositionValue = (await accountBalance.getTotalPositionValue(trader.address, baseToken.address)).abs()

        const marginRatio = await _getMarginRatio(trader)

        const liquidatePositionSize = marginRatio.lt(0.0625 / 2)
            ? positionSize
            : calculateLiquidatePositionSize(positionSize, totalAbsPositionValue, absPositionValue)

        return liquidatePositionSize
    }

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
        mockedBaseAggregator = fixture.mockedBaseAggregator
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        collateralDecimals = await collateral.decimals()

        // initialize ETH pool
        await initMarket(fixture, "1000", 10000, 0, getMaxTickRange(), baseToken.address)
        await syncIndexToMarketPrice(mockedBaseAggregator, pool)

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

        // set blockTimestamp
        await clearingHouse.setBlockTimestamp(blockTimeStamp)
    })

    describe("liquidation in different insuranceFund capacity case", () => {
        beforeEach(async () => {
            // bob longs ETH
            // quote: -1000
            // base: 0.989984344318166945
            await q2bExactInput(fixture, bob, 1000, baseToken.address)

            // mint & deposit usdc to davis
            await mintAndDeposit(fixture, davis, 10000)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)
        })

        it("trader has positive accountValue after liquidation", async () => {
            setPool1IndexPrice(900)

            // after liquidation, trader's accountValue: 29.847554
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
            ).emit(clearingHouse, "PositionLiquidated")
        })

        it("trader has negative accountValue but insuranceFund capacity can cover that", async () => {
            setPool1IndexPrice(800)

            // mint usdc to insuranceFund wallet
            await collateral.mint(insuranceFund.address, parseUnits("100", 6))

            // after liquidation, trader's accountValue: -77.813129
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
            ).emit(clearingHouse, "PositionLiquidated")
        })

        it("trader has negative accountValue but insuranceFund capacity can't cover that", async () => {
            setPool1IndexPrice(800)

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
