import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getNetQuoteBalance", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        marketRegistry = _clearingHouseFixture.marketRegistry
        collateral = _clearingHouseFixture.USDC
        vault = _clearingHouseFixture.vault
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        // 1.0001 ^ 50400 = 154.4310960807
        await pool.initialize(encodePriceSqrt("154", "1"))
        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("100000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 100000, collateral)

        // prepare collateral for taker
        const takerCollateral = parseUnits("10000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await deposit(taker, vault, 10000, collateral)
    })

    describe("no swap, netQuoteBalance should be 0", () => {
        it("taker has no position", async () => {
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq(parseEther("0"))
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(parseEther("0"))
        })

        it("maker adds liquidity below price with quote only", async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000, // 148.3760629
                upperTick: 50200, // 151.3733069
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.eq(0)
            expect(await clearingHouse.getNetQuoteBalance(maker.address)).to.eq(0)
        })

        it("maker adds liquidity above price with base only", async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("3"),
                quote: parseEther("0"),
                lowerTick: 50400,
                upperTick: 50800,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.eq(parseEther("0"))
            expect(await clearingHouse.getNetQuoteBalance(maker.address)).to.eq(parseEther("0"))
        })

        it("maker adds liquidity with both quote and base", async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 0, // $1
                upperTick: 100000, // $22015.4560485522
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            expect(await clearingHouse.getPositionSize(maker.address, baseToken.address)).to.deep.eq(parseEther("0"))
            expect(await clearingHouse.getNetQuoteBalance(maker.address)).to.deep.eq(0)
        })
    })

    describe("netQuoteBalance != 0 after swaps", () => {
        it("a taker swaps and then closes position; maker earns fee", async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("1"),
                quote: parseEther("100"),
                lowerTick: 0, // 1
                upperTick: 100000, // 22015.4560485522
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // taker swaps 1 base to 63.106831428587933867 quote
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // current price = 26.3852759058

            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(parseEther("63.106831428587933867"))
            expect(await clearingHouse.getNetQuoteBalance(maker.address)).to.be.closeTo(
                parseEther("-63.106831428587933867"),
                10,
            )

            await clearingHouse.connect(taker).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker sells all quote, making netQuoteBalance == 0
            expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(0)

            // maker should get > 1 quote as fee, as taker swaps ~= 63 quote twice, which is 126 in total -> 126 * 1% = 1.26
            expect(await clearingHouse.getNetQuoteBalance(maker.address)).gt(parseEther("1"))
        })
    })
})
