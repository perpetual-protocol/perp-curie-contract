import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { BigNumberish } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate maker", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let quoteToken: QuoteToken
    let baseToken: BaseToken
    let mockedBaseAggregator: MockContract
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let mockedBaseAggregator2: MockContract
    let pool2: UniswapV3Pool
    let lowerTick: number
    let upperTick: number
    let collateralDecimals: number

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), 6), 0, 0, 0]
        })
    }

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        quoteToken = _clearingHouseFixture.quoteToken
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2
        pool2 = _clearingHouseFixture.pool2
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt("10", "1"))
        await marketRegistry.addPool(baseToken.address, "10000")

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

        setPool1IndexPrice(100000)

        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
            "CH_CLWTISO",
        )
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

        setPool1IndexPrice(100000)

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
        // alice's expected impermanent position = 10 - 5.025125628140703515 = 4.9748743719
        // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(39.601) - 1 / sqrt(49.9949501326)) = 4.9748743719
        // 31.622776601683793320 * 9 * (sqrt(49.9949501326) - sqrt(39.601)) = 221.3595505626 (imprecision)
        // liquidation fee = 221.3595505626 * 0.025 = 5.5339887641
        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
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

    // hardhat seems to be unable to catch the same events in one tx :(
    // error message: AssertionError: Specified args not emitted in any of 2 emitted "LiquidityChanged" events
    it.skip("bob long, maker (alice) should be liquidated", async () => {
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("1"),
            quote: parseEther("0"),
            lowerTick: "50000",
            upperTick,
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

        setPool1IndexPrice(100000)

        // alice's liquidity = 31.622776601683793320
        // removed/remaining base = 31.622776601683793320 * (1/sqrt(39.601) - 1/sqrt(1.0001^887200)) = 5.0251256281
        // removed/remaining quote = 31.622776601683793320 * (sqrt(39.601) - sqrt(1.0001^(-887200))) = 199
        // expected fee = 1000 * 0.01 * 0.1 (10% of liquidity) = 1

        const order1 = await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
        const order2 = await orderBook.getOpenOrder(alice.address, baseToken.address, "50000", upperTick)

        const tx = await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
        await expect(tx)
            .to.emit(clearingHouse, "LiquidityChanged")
            .withArgs(
                alice.address,
                baseToken.address,
                quoteToken.address,
                lowerTick,
                upperTick,
                parseEther("-5.025125628140703515"),
                parseEther("-198.999999999999999997"),
                order1.liquidity.mul(-1),
                parseEther("0.999999999999999999"),
            )
        await expect(tx)
            .to.emit(clearingHouse, "LiquidityChanged")
            .withArgs(
                alice.address,
                baseToken.address,
                quoteToken.address,
                "50000",
                upperTick,
                parseEther("1"),
                "0",
                order2.liquidity.mul(-1),
                "0",
            )

        // price after liq. = 49.9949501326
        // alice's expected impermanent position = 10 - 5.025125628140703515 = 4.9748743719
        // 31.622776601683793320 * 9 (only carol's liquidity is left) * (1 / sqrt(39.601) - 1 / sqrt(49.9949501326)) = 4.9748743719
        // 31.622776601683793320 * 9 * (sqrt(49.9949501326) - sqrt(39.601)) = 221.3595505626 (imprecision)
        // liquidation fee = 221.3595505626 * 0.025 = 5.5339887641
        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
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

    describe("maker has multiple orders", async () => {
        beforeEach(async () => {
            await pool2.initialize(encodePriceSqrt("10", "1"))
            await marketRegistry.addPool(baseToken2.address, "10000")

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
            setPool1IndexPrice(100000)
            mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("100000", 6), 0, 0, 0]
            })

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool2
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )
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
            setPool1IndexPrice(100000)

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool1
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )

            // maker's margin ratio goes up, another liquidation will fail
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address)).to.be.revertedWith(
                "CH_EAV",
            )
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
            setPool1IndexPrice(100000)

            // cancel maker's order on all markets
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)
            await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken2.address)

            // liquidate maker's position on pool2, but the margin ratio is still too low, maker will be liquidated on pool1
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )

            // liquidate maker's position on pool1
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )
        })
    })
})
