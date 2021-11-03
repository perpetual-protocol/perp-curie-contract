import { defaultAbiCoder } from "@ethersproject/abi"
import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse addLiquidity", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let pool2: UniswapV3Pool
    let collateralDecimals: number
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        clearingHouseConfig = _clearingHouseFixture.clearingHouseConfig
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        baseToken2 = _clearingHouseFixture.baseToken2
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        pool2 = _clearingHouseFixture.pool2
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        collateralDecimals = await collateral.decimals()
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity", () => {
        describe("initialized price = 151.373306858723226652", () => {
            beforeEach(async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                await pool2.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                // add pool after it's initialized
                await marketRegistry.addPool(baseToken.address, 10000)
                await marketRegistry.addPool(baseToken2.address, 10000)
            })

            // @SAMPLE - addLiquidity
            it("add liquidity below price with only quote token", async () => {
                const result = await clearingHouse.connect(alice).callStatic.addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
                expect(result.base).to.be.eq("0")
                expect(result.quote).to.be.eq(parseUnits("10000", await quoteToken.decimals()))
                expect(result.fee).to.be.eq("0")
                expect(result.liquidity).to.be.eq("81689571696303801037492")

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: parseUnits("10000", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        parseUnits("10000", await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("0", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50200],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("81689571696303801037492"), // liquidity
                    50000, // lowerTick
                    50200, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("0", await baseToken.decimals()),
                    parseUnits("10000", await quoteToken.decimals()),
                ])
            })

            it("add liquidity below price with both tokens but expecting only quote token to be added", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("1", await baseToken.decimals()),
                        quote: parseUnits("10000", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        parseUnits("10000", await quoteToken.decimals()),
                        "81689571696303801037492",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("0", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50200],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("81689571696303801037492"), // liquidity
                    50000, // lowerTick
                    50200, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("0", await baseToken.decimals()),
                    parseUnits("10000", await quoteToken.decimals()),
                ])
            })

            it("add liquidity with both tokens, over commit base", async () => {
                const result = await clearingHouse.connect(alice).callStatic.addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
                expect(result.base).to.be.eq(parseUnits("66.061845430469484023", await baseToken.decimals()))
                expect(result.quote).to.be.eq(parseUnits("10000", await quoteToken.decimals()))
                expect(result.fee).to.be.eq("0")
                expect(result.liquidity).to.be.eq("81689571696303801018159")

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("100", await baseToken.decimals()),
                        quote: parseUnits("10000", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        parseUnits("66.061845430469484023", await baseToken.decimals()),
                        parseUnits("10000", await quoteToken.decimals()),
                        "81689571696303801018159",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("-66.061845430469484023", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50400],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("81689571696303801018159"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("66.061845430469484023", await baseToken.decimals()),
                    parseUnits("10000", await quoteToken.decimals()),
                ])
            })

            it("add liquidity with both tokens, over commit quote", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 50 base and 10000 quote
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("50", await baseToken.decimals()),
                        quote: parseUnits("10000", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        parseUnits("50", await baseToken.decimals()),
                        "7568665342936161336147",
                        "61828103017711334685748",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("-50", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("-7568.665342936161336147", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50400],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("61828103017711334685748"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("50", await baseToken.decimals()),
                    BigNumber.from("7568665342936161336147"),
                ])
            })

            it("add liquidity twice", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 66.06184541 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("33.030922715234742012", await baseToken.decimals()),
                    quote: parseUnits("5000", await quoteToken.decimals()),
                    lowerTick: 50000, // from CH's perspective, lowerTick & upperTick is still based on quote/base price, so the number is positive in our test case
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("33.030922715234742012", await baseToken.decimals()),
                    quote: parseUnits("5000", await quoteToken.decimals()),
                    lowerTick: 50000, // from CH's perspective, lowerTick & upperTick is still based on quote/base price, so the number is positive in our test case
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("-66.061845430469484024", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50000, 50400],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("81689571696303801018158"), // liquidity
                    50000, // lowerTick
                    50400, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("66.061845430469484024", await baseToken.decimals()),
                    parseUnits("10000", await quoteToken.decimals()),
                ])
            })

            it("force error, add nothing", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZIs")
            })

            it("force error, add base-only liquidity below price", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("1", await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity above price", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: parseUnits("1", await quoteToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add base-only liquidity in price", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("50", await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote-only liquidity in price", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: parseUnits("10001", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            it("force error, add quote over minted quote", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: parseUnits("100000000", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("CH_NEFCI")
            })

            it("force error, add base over minted base", async () => {
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: 0,
                        quote: parseUnits("1", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("UB_ZL")
            })

            // TODO move to orderbook integration test
            it("force error, non-registered pool calls mint callback", async () => {
                const encodedData = defaultAbiCoder.encode(["address"], [baseToken.address])
                await expect(orderBook.uniswapV3MintCallback(123, 456, encodedData)).to.be.revertedWith(
                    "function call to a non-contract account",
                )
            })

            it("force error, orders number exceeded", async () => {
                await marketRegistry.setMaxOrdersPerMarket("1")

                // alice's first order
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("15", await baseToken.decimals()),
                    quote: parseUnits("2500", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // alice's second order, reverted
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("15", await baseToken.decimals()),
                        quote: parseUnits("2500", await quoteToken.decimals()),
                        lowerTick: 49800,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("OB_ONE")

                // should be fine to add a order in market2,
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken2.address,
                        base: parseUnits("15", await baseToken.decimals()),
                        quote: parseUnits("2500", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.emit(orderBook, "LiquidityChanged")
            })

            it("force error, markets number exceeded", async () => {
                await clearingHouseConfig.setMaxMarketsPerAccount("1")

                // alice's order in market1
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("15", await baseToken.decimals()),
                    quote: parseUnits("2500", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // alice mint in market2 (reverted)
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken2.address,
                        base: parseUnits("0", await baseToken2.decimals()),
                        quote: parseUnits("1", await quoteToken.decimals()),
                        lowerTick: 50000,
                        upperTick: 50200,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("AB_MNE")
            })
        })

        describe("initialized price = 151.373306858723226651", () => {
            beforeEach(async () => {
                await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226651)
                // add pool after it's initialized
                await marketRegistry.addPool(baseToken.address, 10000)
            })

            // @SAMPLE - addLiquidity
            it("add liquidity above price with only base token", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("100", await baseToken.decimals()),
                        quote: 0,
                        lowerTick: 50200,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        parseUnits("100", await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("-100", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("0", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50200, 50400],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("123656206035422669342231"), // liquidity
                    50200, // lowerTick
                    50400, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("100", await baseToken.decimals()),
                    parseUnits("0", await quoteToken.decimals()),
                ])
            })

            it("add liquidity above price with both tokens but expecting only base token to be added", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
                await expect(
                    clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseUnits("100", await baseToken.decimals()),
                        quote: parseUnits("1", await baseToken.decimals()),
                        lowerTick: 50200,
                        upperTick: 50400,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(orderBook, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50200,
                        50400,
                        parseUnits("100", await baseToken.decimals()),
                        0,
                        "123656206035422669342231",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseUnits("-100", await baseToken.decimals()))
                expect(quoteBalance).be.deep.eq(parseUnits("0", await quoteToken.decimals()))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).be.deep.eq([
                    keccak256(
                        ["address", "address", "int24", "int24"],
                        [alice.address, baseToken.address, 50200, 50400],
                    ),
                ])
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
                expect(openOrder).be.deep.eq([
                    BigNumber.from("123656206035422669342231"), // liquidity
                    50200, // lowerTick
                    50400, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    parseUnits("100", await baseToken.decimals()),
                    parseUnits("0", await quoteToken.decimals()),
                ])
            })
        })
    })

    describe("# OrderBook.getOpenOrderById", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226651", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226651)
            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("100", await baseToken.decimals()),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("200", await baseToken.decimals()),
                quote: 0,
                lowerTick: 50400,
                upperTick: 50600,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("getOpenOrderById", async () => {
            const openOrderIds = await orderBook.getOpenOrderIds(alice.address, baseToken.address)
            expect(openOrderIds.length).be.eq(2)

            const openOrder0 = await orderBook.getOpenOrderById(openOrderIds[0])
            expect({
                lowerTick: openOrder0.lowerTick,
                upperTick: openOrder0.upperTick,
            }).be.deep.eq({
                lowerTick: 50200,
                upperTick: 50400,
            })

            const openOrder1 = await orderBook.getOpenOrderById(openOrderIds[1])
            expect({
                lowerTick: openOrder1.lowerTick,
                upperTick: openOrder1.upperTick,
            }).be.deep.eq({
                lowerTick: 50400,
                upperTick: 50600,
            })
        })

        it("getOpenOrderById with non-existent orderId", async () => {
            const nonExistentOrderId = keccak256(
                ["address", "address", "int24", "int24"],
                [bob.address, baseToken.address, 200, 400],
            )

            const emptyOpenOrder = await orderBook.getOpenOrderById(nonExistentOrderId)
            expect({
                lowerTick: emptyOpenOrder.lowerTick,
                upperTick: emptyOpenOrder.upperTick,
            }).be.deep.eq({
                lowerTick: 0,
                upperTick: 0,
            })
        })
    })
})
