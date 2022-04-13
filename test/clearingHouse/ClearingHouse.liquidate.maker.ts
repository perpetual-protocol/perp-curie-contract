import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt, filterLogs } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate maker", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: ClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let clearingHouseConfig: ClearingHouseConfig
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    enum Pool {
        Pool1,
        Pool2,
    }

    function setPoolIndexPrice(price: BigNumberish, pool: Pool) {
        const aggregator: MockContract = pool == Pool.Pool1 ? mockedBaseAggregator : mockedBaseAggregator2
        aggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), 6), 0, 0, 0]
        })
    }

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        clearingHouseConfig = fixture.clearingHouseConfig
        collateral = fixture.USDC
        quoteToken = fixture.quoteToken
        baseToken = fixture.baseToken
        mockedBaseAggregator = fixture.mockedBaseAggregator
        pool = fixture.pool
        baseToken2 = fixture.baseToken2
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2
        pool2 = fixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("10", "1"),
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // alice add v2 style liquidity
        await collateral.mint(alice.address, parseUnits("200", collateralDecimals))
        await deposit(alice, vault, 200, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("100"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("90"),
            quote: parseEther("900"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
    })

    it("force fail, maker still has liquidity", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
        await deposit(bob, vault, 10000000, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("1000"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        setPoolIndexPrice(100000, Pool.Pool1)

        await expect(
            clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
        ).to.be.revertedWith("CH_CLWTISO")
    })

    // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=1758593105
    it("bob long, maker (alice) should be liquidated", async () => {
        // bob long
        await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
        await deposit(bob, vault, 10000000, collateral)
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: false, // quote to base
            isExactInput: true,
            oppositeAmountBound: 0, // exact input (quote)
            amount: parseEther("1000"),
            sqrtPriceLimitX96: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })
        // price after swap: 39.601

        setPoolIndexPrice(100000, Pool.Pool1)

        // alice's liquidity = 31.622776601683793320
        // removed/remaining base = 31.622776601683793320 * (1/sqrt(39.601) - 1/sqrt(1.0001^887200)) = 5.0251256281
        // removed/remaining quote = 31.622776601683793320 * (sqrt(39.601) - sqrt(1.0001^(-887200))) = 199
        // expected fee = 1000 * 0.01 * 0.1 (10% of liquidity) = 1

        const order = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        await expect(await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address))
            .to.emit(clearingHouse, "LiquidityChanged")
            .withArgs(
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                upperTick,
                parseEther("-5.025125628140703515"),
                parseEther("-198.999999999999999997"),
                order.liquidity.mul(-1),
                parseEther("0.999999999999999999"),
            )

        // price after liq. = 49.9949501326
        // alice's expected impermanent position = -(10 - 5.025125628140703515) = -4.9748743719
        // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(39.601) - 1 / sqrt(49.9949501326)) = 4.9748743719
        // 31.622776601683793320 * 9 * (sqrt(49.9949501326) - sqrt(39.601)) = 221.3595505626 (imprecision)
        // liquidation fee = 221.3595505626 * 0.025 = 5.5339887641
        await expect(
            clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
        )
            .to.emit(clearingHouse, "PositionLiquidated")
            .withArgs(
                alice.address,
                baseToken.address,
                parseEther("221.359550561797752885"),
                parseEther("4.974874371859296484"),
                parseEther("5.533988764044943822"),
                davis.address,
            )
    })

    describe("alice has three orders: below, in range and above", async () => {
        it("bob long, all alice's orders should be cancelled and positions be liquidated", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("0"),
                lowerTick: "50000", // 148.3760629231
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("10"),
                lowerTick,
                upperTick: "200", // 1.0202003199
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob long
            await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
            await deposit(bob, vault, 10000000, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after swap: 39.601

            setPoolIndexPrice(100000, Pool.Pool1)

            const order1 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const order2 = await orderBook.getOpenOrder(alice.address, baseToken.address, "50000", upperTick)
            const order3 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, "200")

            const tx = await (
                await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            ).wait()
            const logs = filterLogs(tx, clearingHouse.interface.getEventTopic("LiquidityChanged"), clearingHouse)

            // alice's liquidity = 31.622776601683793320
            // removed/remaining base = 31.622776601683793320 * (1/sqrt(39.601) - 1/sqrt(1.0001^887200)) = 5.0251256281
            // removed/remaining quote = 31.622776601683793320 * (sqrt(39.601) - sqrt(1.0001^(-887200))) = 199
            // expected fee = 1000 * 0.01 * 0.1 (10% of liquidity) = 1
            expect(logs[0].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                upperTick,
                parseEther("-5.025125628140703515"),
                parseEther("-198.999999999999999997"),
                order1.liquidity.mul(-1),
                parseEther("0.999999999999999999"),
            ])
            expect(logs[1].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                50000,
                upperTick,
                parseEther("-0.999999999999999999"),
                parseEther("0"),
                order2.liquidity.mul(-1),
                parseEther("0"),
            ])
            expect(logs[2].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                200,
                parseEther("0"),
                parseEther("-9.999999999999999999"),
                order3.liquidity.mul(-1),
                parseEther("0"),
            ])

            // price after liq. = 49.9949501326
            // alice's expected impermanent position = -(10 - 5.025125628140703515) = -4.9748743719
            // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(39.601) - 1 / sqrt(49.9949501326)) = 4.9748743719
            // 31.622776601683793320 * 9 * (sqrt(49.9949501326) - sqrt(39.601)) = 221.3595505626 (imprecision)
            // liquidation fee = 221.3595505626 * 0.025 = 5.5339887641
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    parseEther("221.359550561797752935"),
                    parseEther("4.974874371859296485"),
                    parseEther("5.533988764044943823"),
                    davis.address,
                )
        })
    })

    describe("maker has multiple orders", async () => {
        it("alice has three orders: below, in range and above; bob long, all alice's orders should be cancelled and positions be liquidated", async () => {
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("0"),
                lowerTick: "50000", // 148.3760629231
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("10"),
                lowerTick,
                upperTick: "200", // 1.0202003199
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob long
            await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
            await deposit(bob, vault, 10000000, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // price after swap: 39.601

            setPoolIndexPrice(100000, Pool.Pool1)

            const order1 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            const order2 = await orderBook.getOpenOrder(alice.address, baseToken.address, "50000", upperTick)
            const order3 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, "200")

            const tx = await (
                await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            ).wait()
            const logs = filterLogs(tx, clearingHouse.interface.getEventTopic("LiquidityChanged"), clearingHouse)

            // alice's liquidity = 31.622776601683793320
            // removed/remaining base = 31.622776601683793320 * (1/sqrt(39.601) - 1/sqrt(1.0001^887200)) = 5.0251256281
            // removed/remaining quote = 31.622776601683793320 * (sqrt(39.601) - sqrt(1.0001^(-887200))) = 199
            // expected fee = 1000 * 0.01 * 0.1 (10% of liquidity) = 1
            expect(logs[0].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                upperTick,
                parseEther("-5.025125628140703515"),
                parseEther("-198.999999999999999997"),
                order1.liquidity.mul(-1),
                parseEther("0.999999999999999999"),
            ])
            expect(logs[1].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                50000,
                upperTick,
                parseEther("-0.999999999999999999"),
                parseEther("0"),
                order2.liquidity.mul(-1),
                parseEther("0"),
            ])
            expect(logs[2].args).to.deep.eq([
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                200,
                parseEther("0"),
                parseEther("-9.999999999999999999"),
                order3.liquidity.mul(-1),
                parseEther("0"),
            ])

            // price after liq. = 49.9949501326
            // alice's expected impermanent position = -(10 - 5.025125628140703515) = -4.9748743719
            // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(39.601) - 1 / sqrt(49.9949501326)) = 4.9748743719
            // 31.622776601683793320 * 9 * (sqrt(49.9949501326) - sqrt(39.601)) = 221.3595505626 (imprecision)
            // liquidation fee = 221.3595505626 * 0.025 = 5.5339887641
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            )
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    parseEther("221.359550561797752935"),
                    parseEther("4.974874371859296485"),
                    parseEther("5.533988764044943823"),
                    davis.address,
                )
        })

        describe("multiple orders in different pools", () => {
            beforeEach(async () => {
                await pool2.initialize(encodePriceSqrt("10", "1"))
                await marketRegistry.addPool(baseToken2.address, "10000")
                await exchange.setMaxTickCrossedWithinBlock(baseToken2.address, getMaxTickRange())

                // alice add v2 style liquidity in pool2
                await collateral.mint(alice.address, parseUnits("200", collateralDecimals))
                await deposit(alice, vault, 200, collateral)
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken2.address,
                    base: parseEther("10"),
                    quote: parseEther("100"),
                    lowerTick,
                    upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
                await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
                await deposit(carol, vault, 1000, collateral)
                await clearingHouse.connect(carol).addLiquidity({
                    baseToken: baseToken2.address,
                    base: parseEther("90"),
                    quote: parseEther("900"),
                    lowerTick,
                    upperTick,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
            })

            it("maker loses in both pools, should cancel & liquidate all of her orders", async () => {
                // bob long in pool1
                await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
                await deposit(bob, vault, 10000000, collateral)
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false, // quote to base
                    isExactInput: true,
                    oppositeAmountBound: 0, // exact input (quote)
                    amount: parseEther("1000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // bob long in pool2
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: false, // quote to base
                    isExactInput: true,
                    oppositeAmountBound: 0, // exact input (quote)
                    amount: parseEther("1000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // index prices of both pool1 and pool2 go up so that alice can be liquidated in both pools
                setPoolIndexPrice(100000, Pool.Pool1)
                setPoolIndexPrice(100000, Pool.Pool2)

                const order = await orderBook.getOpenOrder(alice.address, baseToken2.address, lowerTick, upperTick)
                // cancel maker's order on all markets
                await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
                // values should be the same as previous examples
                await expect(clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address))
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken2.address,
                        quoteToken.address,
                        lowerTick,
                        upperTick,
                        parseEther("-5.025125628140703515"),
                        parseEther("-198.999999999999999997"),
                        order.liquidity.mul(-1),
                        parseEther("0.999999999999999999"),
                    )

                // liquidating all maker's positions
                await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
                ).to.emit(clearingHouse, "PositionLiquidated")
                // values should be the same as previous examples
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
                )
                    .to.emit(clearingHouse, "PositionLiquidated")
                    .withArgs(
                        alice.address,
                        baseToken2.address,
                        parseEther("221.359550561797752885"),
                        parseEther("4.974874371859296484"),
                        parseEther("5.533988764044943822"),
                        davis.address,
                    )
            })

            describe("maker loses in pool1", () => {
                beforeEach(async () => {
                    await collateral.mint(bob.address, parseUnits("100000", collateralDecimals))
                    await deposit(bob, vault, 100000, collateral)
                })

                it("two orders in pool1 and one order in pool2; after liquidation in pool1, margin ratio is already enough", async () => {
                    await clearingHouse.connect(alice).addLiquidity({
                        baseToken: baseToken.address,
                        base: parseEther("1"),
                        quote: parseEther("0"),
                        lowerTick: 25000, // 12.1809713456
                        upperTick: 35000, // 33.1096576479
                        minBase: 0,
                        minQuote: 0,
                        useTakerBalance: false,
                        deadline: ethers.constants.MaxUint256,
                    })

                    // bob long in pool1
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false, // quote to base
                        isExactInput: true,
                        oppositeAmountBound: 0, // exact input (quote)
                        amount: parseEther("1000"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })
                    // price after swap: 38.805748602

                    setPoolIndexPrice(100000, Pool.Pool1)

                    const order1 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    const order2 = await orderBook.getOpenOrder(alice.address, baseToken.address, 25000, 35000)

                    await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)
                    const tx = await (
                        await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
                    ).wait()
                    const logs = filterLogs(
                        tx,
                        clearingHouse.interface.getEventTopic("LiquidityChanged"),
                        clearingHouse,
                    )

                    // alice's liquidity2 = 8.870473434863612760
                    // removed/remaining base = 0, cuz the price is above the upper bound
                    // removed/remaining quote = 8.870473434863612760 * (sqrt(1.0001^35000) - sqrt(1.0001^25000)) = 20.0825245194
                    // expected fee = 20.0825245194 / 0.99 * 0.01 = 0.202853783
                    expect(logs[1].args).to.deep.eq([
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        25000,
                        35000,
                        parseEther("0"),
                        parseEther("-20.082524519410365786"),
                        order2.liquidity.mul(-1),
                        parseEther("0.202853783024347129"),
                    ])

                    // alice's liquidity1 = 31.622776601683793320
                    // removed/remaining base = 31.622776601683793320 * (1/sqrt(38.805748602) - 1/sqrt(1.0001^887200)) = 5.0763547836
                    // removed/remaining quote = 31.622776601683793320 * (sqrt(38.805748602) - sqrt(1.0001^(-887200))) = 196.991747548
                    // expected fee = (1000 * 0.01 - 0.202853783 (fee of liquidity2)) * 0.1 (10% of liquidity) = 0.9797146217
                    expect(logs[0].args).to.deep.eq([
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        lowerTick,
                        upperTick,
                        parseEther("-5.076354783623794447"),
                        parseEther("-196.991747548058963418"),
                        order1.liquidity.mul(-1),
                        parseEther("0.979714621697565287"),
                    ])

                    // price after liq. = 51.2288687261
                    // alice's expected impermanent position from liquidity1 = -(10 - 5.0763547836) = -4.9236452164
                    // alice's expected impermanent position from liquidity2 = -1
                    // alice's total expected impermanent position = -4.9236452164 + -1 = -5.9236452164
                    // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(38.805748602) - 1 / sqrt(51.2288687261)) = 5.9236452164
                    // 31.622776601683793320 * 9 * (sqrt(51.2288687261) - sqrt(38.805748602)) = 264.1158442544 (imprecision)
                    // liquidation fee = 264.1158442544 * 0.025 = 6.6028961064
                    await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)
                    await expect(
                        clearingHouse
                            .connect(davis)
                            ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
                    )
                        .to.emit(clearingHouse, "PositionLiquidated")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            parseEther("264.115844252881833583"),
                            parseEther("5.923645216376205552"),
                            parseEther("6.602896106322045839"),
                            davis.address,
                        )

                    // the reason is that index price is way off, thus the actual loss is smaller than it seems and there's no need to liquidate the position in pool2
                    await expect(
                        clearingHouse
                            .connect(davis)
                            ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
                    ).to.be.revertedWith("CH_EAV")
                })

                it("one order in each market; liquidation in pool2 doesn't help margin ratio, thus also liquidating the position in pool1", async () => {
                    // bob long in pool1
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false, // quote to base
                        isExactInput: true,
                        oppositeAmountBound: 0, // exact input (quote)
                        amount: parseEther("1000"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    // bob long in pool2
                    await clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken2.address,
                        isBaseToQuote: false, // quote to base
                        isExactInput: true,
                        oppositeAmountBound: 0, // exact input (quote)
                        amount: parseEther("1000"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    })

                    // only pool1 index price goes up
                    setPoolIndexPrice(100000, Pool.Pool1)

                    // cancel maker's order on all markets
                    await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
                    await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

                    // notice that in this case, liquidation happens in pool2 first, which is different from the above case
                    // since the loss is incurred in pool1, liquidating position in pool2 doesn't help margin ratio much
                    await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)
                    await expect(
                        clearingHouse
                            .connect(davis)
                            ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
                    ).to.emit(clearingHouse, "PositionLiquidated")
                    // thus, have to then liquidate position in pool1
                    await expect(
                        clearingHouse
                            .connect(davis)
                            ["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
                    ).to.emit(clearingHouse, "PositionLiquidated")
                })
            })
        })
    })

    describe("maker has multiple orders part 2", async () => {
        beforeEach(async () => {
            await initAndAddPool(
                fixture,
                pool2,
                baseToken2.address,
                encodePriceSqrt("10", "1"),
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            // alice add v2 style liquidity on pool2
            await collateral.mint(alice.address, parseUnits("200", collateralDecimals))
            await deposit(alice, vault, 200, collateral)
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("10"),
                quote: parseEther("100"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // so do carol (to avoid liquidity is 0 when any of the maker remove 100% liquidity)
            await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("90"),
                quote: parseEther("900"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("maker loss on both pools, should cancel all of her orders and liquidate all of them", async () => {
            // bob long on pool1
            await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
            await deposit(bob, vault, 10000000, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob long on pool2
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // pool1 and pool2 index price goes up so that alice can be liquidated
            setPoolIndexPrice(100000, Pool.Pool1)

            mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool2 (with bad debt)
            await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")
        })

        it("maker loss on pool1, should cancel all of her orders and liquidate on pool1", async () => {
            // bob long on pool1
            await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
            await deposit(bob, vault, 10000000, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob long on pool2
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // only pool1 index price goes up
            setPoolIndexPrice(100000, Pool.Pool1)

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool1
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")

            // maker's margin ratio goes up, another liquidation will fail
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
            ).to.be.revertedWith("CH_EAV")
        })

        it("maker loss on pool1, should cancel all of her orders and liquidate on pool2 then pool1", async () => {
            // bob long on pool1
            await collateral.mint(bob.address, parseUnits("10000000", collateralDecimals))
            await deposit(bob, vault, 10000000, collateral)
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob long on pool2
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0, // exact input (quote)
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // only pool1 index price goes up
            setPoolIndexPrice(100000, Pool.Pool1)

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool2, but the margin ratio is still too low, maker will be liquidated on pool1
            await clearingHouseConfig.setBackstopLiquidityProvider(davis.address, true)
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,uint256)"](alice.address, baseToken2.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")

            // liquidate maker's position on pool1
            await expect(
                clearingHouse.connect(davis)["liquidate(address,address,uint256)"](alice.address, baseToken.address, 0),
            ).to.emit(clearingHouse, "PositionLiquidated")
        })
    })
})
