import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition oneWeiFee", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        // const exFeeRatio = 10000 // 1%
        // const uniFeeRatio = 10000 // 1%

        const exFeeRatio = 1000 // 0.1% in production
        const uniFeeRatio = 3000 // 0.3% in production

        fixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        clearingHouseConfig = fixture.clearingHouseConfig
        vault = fixture.vault
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        const initPrice = "151.373306858723226652"
        const marketTicks = await initMarket(fixture, initPrice, exFeeRatio, 0)
        const lowerTick = marketTicks.minTick
        const upperTick = marketTicks.maxTick
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("10000000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(vault.address, takerCollateral)
    })

    describe("there will be extra 1 wei fee charged when Q2B with exact input", () => {
        beforeEach(async () => {
            await vault.connect(taker).deposit(collateral.address, parseUnits("100000", collateralDecimals))
        })

        describe("quote checking", () => {
            it("short exact output", async () => {
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                expect(response.quote).to.be.eq(parseEther("1000"))
            })

            it("long exact input", async () => {
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    // amount: parseEther("1000"),
                    amount: "1280383806188353801279",
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // expect(response.quote).to.be.eq(parseEther("1000"))
                expect(response.quote).to.be.eq("1280383806188353801279")
            })
        })

        describe("base checking", () => {
            it("short exact input", async () => {
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1.383806188353801279"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                expect(response.base).to.be.eq(parseEther("1.383806188353801279"))
            })

            it("long exact output", async () => {
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1.383806188353801279"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                expect(response.base).to.be.eq(parseEther("1.383806188353801279"))
            })
        })
    })
})
