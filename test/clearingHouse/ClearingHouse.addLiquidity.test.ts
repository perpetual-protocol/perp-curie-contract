import { defaultAbiCoder } from "@ethersproject/abi"
import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
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
import { b2qExactInput, q2bExactOutput, removeOrder } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse addLiquidity", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let accountBalance: TestAccountBalance
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

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        clearingHouseConfig = fixture.clearingHouseConfig
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        pool2 = fixture.pool2
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateralDecimals = await collateral.decimals()

        // mint
        collateral.mint(admin.address, parseUnits("100000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("10000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 10000, collateral)
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("# addLiquidity without using taker's position", () => {
        describe("initialized price = 151.373306858723226652", () => {
            beforeEach(async () => {
                await initAndAddPool(
                    fixture,
                    pool,
                    baseToken.address,
                    encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                    10000,
                    // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                    getMaxTickRange(),
                )

                await initAndAddPool(
                    fixture,
                    pool2,
                    baseToken2.address,
                    encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                    10000,
                    // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                    getMaxTickRange(),
                )
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
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                expect(result.base).to.be.eq("0")
                expect(result.quote).to.be.eq(parseUnits("10000", await quoteToken.decimals()))
                expect(result.fee).to.be.eq("0")
                expect(result.liquidity).to.be.eq("81689571696303801037492")

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                const tx = await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                await expect(tx)
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                await expect(tx).to.not.emit(accountBalance, "PnlRealized")

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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                expect(result.base).to.be.eq(parseUnits("66.061845430469484023", await baseToken.decimals()))
                expect(result.quote).to.be.eq(parseUnits("10000", await quoteToken.decimals()))
                expect(result.fee).to.be.eq("0")
                expect(result.liquidity).to.be.eq("81689571696303801018159")

                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                const tx = await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                await expect(tx)
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                await expect(tx).to.not.emit(accountBalance, "PnlRealized")

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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                    useTakerBalance: false,
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
                    useTakerBalance: false,
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                        useTakerBalance: false,
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
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
                    useTakerBalance: false,
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
                        useTakerBalance: false,
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.emit(clearingHouse, "LiquidityChanged")
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
                    useTakerBalance: false,
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.revertedWith("AB_MNE")
            })
        })

        describe("initialized price = 151.373306858723226651", () => {
            beforeEach(async () => {
                await initAndAddPool(
                    fixture,
                    pool,
                    baseToken.address,
                    encodePriceSqrt("151.373306858723226651", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226651)
                    10000,
                    // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                    getMaxTickRange(),
                )
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
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
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
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

    // TODO add this back once we enable the addLiquidity(useTakerBalance)
    describe.skip("# addLiquidity using taker's position", () => {
        let bobTakerQuote
        let bobBase
        let bobQuote

        const aliceLowerTick = 50000
        const aliceUpperTick = 50400

        beforeEach(async () => {
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226651", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226651)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("10000"),
                lowerTick: aliceLowerTick,
                upperTick: aliceUpperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob long 1 base token
            await q2bExactOutput(fixture, bob, 1)
            bobTakerQuote = (await accountBalance.getAccountInfo(bob.address, baseToken.address)).takerOpenNotional
            bobBase = await accountBalance.getBase(bob.address, baseToken.address)
            bobQuote = await accountBalance.getQuote(bob.address, baseToken.address)
            // bob's account info:
            // totalQuote: -152.925362473060470222
            // totalBase: 1
            // takerQuote: -152.925362473060470222
            // takerBase: 1
        })

        it("existing position size is enough for adding liquidity", async () => {
            const lowerTick = 50400
            const upperTick = 50600

            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: 0,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    parseEther("-0.5"), // exchangedPositionSize
                    bobTakerQuote.div(2).mul(-1), // exchangedPositionNotional
                    0, // fee
                    "-76462681236530235111", // openNotional
                    "0", // realizedPnl
                    Object, // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.eq(parseEther("0.5"))

            const bobAccountInfo = await accountBalance.getAccountInfo(bob.address, baseToken.address)
            expect(bobAccountInfo.takerPositionSize).to.eq(parseEther("0.5"))
            expect(bobAccountInfo.takerOpenNotional).to.eq(bobTakerQuote.div(2))
            expect(await accountBalance.getBase(bob.address, baseToken.address)).to.eq(parseEther("0.5"))
            expect(await accountBalance.getQuote(bob.address, baseToken.address)).to.eq(bobQuote)

            const [netQuoteBalance, fee] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.be.closeTo(bobBase, 1)
            expect(netQuoteBalance.add(fee)).to.eq(bobQuote)
            expect(await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)).to.eq(bobQuote)
        })

        it("has the same taker position size after removing liquidity if no one else trade", async () => {
            const lowerTick = 50400
            const upperTick = 50600

            await clearingHouse.connect(bob).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0.5"),
                quote: 0,
                lowerTick: lowerTick,
                upperTick: upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: true,
                deadline: ethers.constants.MaxUint256,
            })

            const liquidity = (await orderBook.getOpenOrder(bob.address, baseToken.address, lowerTick, upperTick))
                .liquidity
            await expect(
                clearingHouse.connect(bob).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    parseEther("0.499999999999999999"), // exchangedPositionSize
                    bobTakerQuote.div(2), // exchangedPositionNotional
                    0, // fee
                    "-152925362473060470222", // openNotional
                    "0", // realizedPnl
                    Object, // sqrtPriceAfterX96
                )

            expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.closeTo(
                parseEther("1"),
                1,
            )

            const bobAccountInfo = await accountBalance.getAccountInfo(bob.address, baseToken.address)
            expect(bobAccountInfo.takerPositionSize).to.be.closeTo(parseEther("1"), 1)
            expect(bobAccountInfo.takerOpenNotional).to.eq(bobTakerQuote)
            expect(await accountBalance.getBase(bob.address, baseToken.address)).to.be.closeTo(bobBase, 1)
            expect(await accountBalance.getQuote(bob.address, baseToken.address)).to.eq(bobQuote)

            const [netQuoteBalance, fee] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.be.closeTo(bobBase, 1)
            expect(netQuoteBalance.add(fee)).to.eq(bobQuote)
            expect(await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)).to.eq(bobQuote)
        })

        it("adding liquidity using taker position and somebody trade", async () => {
            const lowerTick = 50400
            const upperTick = 50600

            // remove alice liquidity to maker test easier
            const aliceLiquidity = (
                await orderBook.getOpenOrder(alice.address, baseToken.address, aliceLowerTick, aliceUpperTick)
            ).liquidity
            await removeOrder(fixture, alice, aliceLiquidity, aliceLowerTick, aliceUpperTick, baseToken.address)

            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: 0,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    // using 50% taker base to add liquidity
                    parseEther("-0.5"), // exchangedPositionSize
                    // move 50% taker quote debt to maker
                    bobTakerQuote.div(2).mul(-1), // exchangedPositionNotional
                    0, // fee
                    "-76462681236530235111", // openNotional
                    "0", // realizedPnl
                    Object, // sqrtPriceAfterX96
                )

            // alice long 0.1 base token
            await q2bExactOutput(fixture, alice, 0.1)

            const bobLiquidity = (await orderBook.getOpenOrder(bob.address, baseToken.address, lowerTick, upperTick))
                .liquidity

            const tx = await clearingHouse.connect(bob).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: bobLiquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            await expect(tx).to.emit(clearingHouse, "LiquidityChanged").withArgs(
                bob.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                upperTick,
                parseEther("-0.399999999999999999"),
                parseEther("-15.473901654978787729"), // we don't care about this value. it's from console.log.
                bobLiquidity.mul(-1),
                parseEther("0.156302036918977653"), // we don't care about this value. it's from console.log.
            )
            await expect(tx).to.emit(clearingHouse, "PositionChanged").withArgs(
                bob.address,
                baseToken.address,
                parseEther("0.399999999999999999"), // exchangedPositionSize
                parseEther("-60.988779581551447382"), // exchangedPositionNotional
                "0", // fee
                "-137451460818081682493", // openNotional
                "0", // realizedPnl
                Object, // sqrtPriceAfterX96
            )

            expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.closeTo(
                parseEther("0.9"),
                1,
            )

            // totalQuote = totalQuote(before) + quoteRemovedFromPool
            //            = -152.925362473060470222 + 15.473901654978787729
            //            = -137.451460818

            // takerQuote = takerQuote(before) * ratio to add liquidity + deltaTakerBase
            //            = -152.925362473060470222 /2 + (-60.988779581551447382)
            //            = -137.451460818
            const bobAccountInfo = await accountBalance.getAccountInfo(bob.address, baseToken.address)
            expect(bobAccountInfo.takerPositionSize).to.be.closeTo(parseEther("0.9"), 1)
            expect(bobAccountInfo.takerOpenNotional).to.eq(parseEther("-137.451460818081682493"))
            expect(await accountBalance.getBase(bob.address, baseToken.address)).to.be.closeTo(parseEther("0.9"), 1)
            expect(await accountBalance.getQuote(bob.address, baseToken.address)).to.eq(
                parseEther("-137.451460818081682493"),
            )

            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.be.closeTo(
                parseEther("0.9"),
                1,
            )
            const [netQuoteBalance, fee] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(netQuoteBalance.add(fee)).to.eq(parseEther("-137.451460818081682493"))
            expect(await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)).to.eq(
                parseEther("-137.451460818081682493"),
            )
        })

        it("adding liquidity twice, one is using taker position and the second one without using taker position", async () => {
            const lowerTick = 50400
            const upperTick = 50600

            // remove alice liquidity to maker test easier
            const aliceLiquidity = (
                await orderBook.getOpenOrder(alice.address, baseToken.address, aliceLowerTick, aliceUpperTick)
            ).liquidity
            await removeOrder(fixture, alice, aliceLiquidity, aliceLowerTick, aliceUpperTick, baseToken.address)

            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: "0",
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "PositionChanged")
                .withArgs(
                    bob.address,
                    baseToken.address,
                    parseEther("-0.5"), // exchangedPositionSize
                    bobTakerQuote.div(2).mul(-1), // exchangedPositionNotional
                    0, // fee
                    "-76462681236530235111", // openNotional
                    "0", // realizedPnl
                    Object, // sqrtPriceAfterX96
                )

            // alice long 0.1 base token
            await q2bExactOutput(fixture, alice, 0.1)

            // bob add liquidity w/o using taker position
            await expect(
                await clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: parseEther("19.342377068723484663"),
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).not.to.emit(clearingHouse, "PositionChanged") // since useTakerBalance: false
            // NOTE: Once we call ".not.", it will negate all assertions that follow in the chain.
            // ALWAYS put ".not" in the end of the chained operation, for instance:
            // to.emit(contract1, "LiquidityChanged").and.not.to.emit(contract2, "PositionChanged")

            // alice long 0.1 base token
            await q2bExactOutput(fixture, alice, 0.1)

            const bobLiquidity = (await orderBook.getOpenOrder(bob.address, baseToken.address, lowerTick, upperTick))
                .liquidity

            await removeOrder(fixture, bob, bobLiquidity, lowerTick, upperTick, baseToken.address)

            // baseRemovedFromPool: 0.799999999999999999
            // quoteRemovedFromPool: 50.334785991896479848

            expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.closeTo(
                parseEther("0.8"),
                1,
            )

            // totalQuote = totalQuote(before) - quoteDebt + quoteRemovedFromPool
            //            = -152.925362473060470222 - 19.342377068723484663 + 50.334785991896479848
            //            = -121.93295355

            // takerQuote = takerQuote(before) * ratio to add liquidity + deltaTakerBase
            //            = takerQuote(before) * ratio to add liquidity + (quoteRemovedFromPool - (quoteDebt from taker + quoteDebt))
            //            = -152.925362473060470222*0.5 + (50.334785991896479848-(152.925362473060470222*0.5+19.342377068723484663))
            //            = -121.93295355

            const bobAccountInfo = await accountBalance.getAccountInfo(bob.address, baseToken.address)

            expect(bobAccountInfo.takerPositionSize).to.be.closeTo(parseEther("0.8"), 1)
            expect(bobAccountInfo.takerOpenNotional).to.eq(parseEther("-121.932953549887475037"))
            expect(await accountBalance.getBase(bob.address, baseToken.address)).to.be.closeTo(parseEther("0.8"), 1)
            expect(await accountBalance.getQuote(bob.address, baseToken.address)).to.eq(
                parseEther("-121.932953549887475037"),
            )

            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.be.closeTo(
                parseEther("0.8"),
                1,
            )
            const [netQuoteBalance, fee] = await accountBalance.getNetQuoteBalanceAndPendingFee(bob.address)
            expect(netQuoteBalance.add(fee)).to.eq(parseEther("-121.932953549887475037"))
            expect(await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)).to.eq(
                parseEther("-121.932953549887475037"),
            )
        })

        it("force error, existing position size is not enough for adding liquidity", async () => {
            // bob has only 1 base, thus cannot add liquidity using more than 1 base/ taker's position size
            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("1.5"),
                    quote: 0,
                    lowerTick: "50400",
                    upperTick: "50600",
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.revertedWith("CH_TBNE")
        })

        it("force error, existing taker quote is not enough for adding liquidity", async () => {
            await b2qExactInput(fixture, bob, 2)

            // bob has only -1 base and ? quote, thus cannot add liquidity using more than ? taker quote
            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseEther("10000"),
                    lowerTick: "49800",
                    upperTick: "50000",
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.revertedWith("CH_TQNE")
        })

        it("force error, cannot add liquidity within range", async () => {
            // current tick: 50200
            // bob has 1 base, cannot add liquidity within the price range
            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: parseEther("50"),
                    lowerTick: "50200",
                    upperTick: "50600",
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.revertedWith("CH_CALWRFTP")
        })
    })

    describe("# OrderBook.getOpenOrderById", () => {
        beforeEach(async () => {
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226651", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226651)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("100", await baseToken.decimals()),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
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
                useTakerBalance: false,
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

    describe("force error", () => {
        beforeEach(async () => {
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )
        })

        it("add 0 liquidity will fail", async () => {
            // the error is emitted from FullMath.mulDiv(), for the numerator == 0
            await expect(
                clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: 0,
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.reverted
        })

        it("disable adding liquidity using taker balance", async () => {
            const aliceLowerTick = 50000
            const aliceUpperTick = 50400

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: parseEther("10000"),
                lowerTick: aliceLowerTick,
                upperTick: aliceUpperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob long 1 base token
            await q2bExactOutput(fixture, bob, 1)

            await expect(
                clearingHouse.connect(bob).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.5"),
                    quote: 0,
                    lowerTick: 50400,
                    upperTick: 50600,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: true,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.revertedWith("CH_DUTB")
        })
    })
})
