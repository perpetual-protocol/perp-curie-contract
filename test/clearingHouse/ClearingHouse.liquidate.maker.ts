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
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
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
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
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

        setPool1IndexPrice(100000)

        await clearingHouse.connect(davis).cancelAllExcessOrders(alice.address, baseToken.address)

        await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address)).to.emit(
            clearingHouse,
            "PositionLiquidated",
        )
    })

    describe("maker has multiple orders", async () => {
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
