import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool } from "../../typechain"
import { toWei } from "../helper/number"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getTotalMarketPnl", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await pool.initialize(encodePriceSqrt("100", "1"))

        // prepare collateral for maker
        const makerCollateralAmount = toWei(1000000, collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await collateral.connect(maker).approve(clearingHouse.address, makerCollateralAmount)
        await clearingHouse.connect(maker).deposit(makerCollateralAmount)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, toWei(10000))
        await clearingHouse.connect(maker).mint(quoteToken.address, toWei(10000))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(10000),
            lowerTick,
            upperTick,
        })

        // prepare collateral for taker
        const takerCollateral = toWei(10000, collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await clearingHouse.connect(taker).deposit(takerCollateral)

        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await collateral.connect(taker2).approve(clearingHouse.address, takerCollateral)
        await clearingHouse.connect(taker2).deposit(takerCollateral)
    })

    describe("taker", () => {
        it("taker open long and price goes up", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 101.8550797108
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.8550797 = 99.9140448603
            // cost basis = -100
            // pnl = -100 + 99.9140448603 = -0.0859551397
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-85955129155713749")

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 103.7272082538
            // taker1
            // position value = 0.980943170969551031 * 103.7272082538 = 101.7504965803
            // pnl = -100 + 101.7504965803 = 1.7504965803
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("1750496580332248211")
        })

        it("taker open long and price goes down", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 101.8550797108
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.8550797 = 99.9140448603
            // cost basis = -100
            // pnl = -100 + 99.9140448603 = -0.0859551397
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-85955129155713749")

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // price after swap: 98.125012874
            // taker1
            // position value = 0.980943170969551031 * 98.125012874 = 96.25506128
            // pnl = -100 + 96.25506128 = -3.74493872
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-3744938719958505346")
        })

        it("taker open short and price goes up", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490128
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490128 = -99.0673963158
            // net quote amount = 99
            // pnl = 99 - 99.0673963158 = -0.0673963158
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-67396315840948686")

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 99.9813487961
            // taker1
            // position value = -1.009413830572328542 * 99.9813487961 = -100.9225562741
            // pnl = 99 + -100.9225562741 = -1.9225562741
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-1922556274025504498")
        })

        it("taker open short and price goes down", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490128
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490128 = -99.0673963158
            // cost basis = 99
            // pnl = 99 - 99.0673963158 = -0.0673963158
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-67396315840948686")

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // price after swap: 94.4460321966
            // taker1
            // position value = -1.009413830572328542 * 94.4826553619 = -95.3720990715
            // pnl = 99 - 95.3720990715 = 3.6279009285
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("3627900928500046087")
        })
    })

    describe("maker", () => {
        it("verify maker's pnl when price goes up", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 101.8550797108
            // taker
            //  - position size = 0.980943170969551031
            // maker
            //  - position size = -0.980943170969551031
            //  - position value = -0.980943170969551031 * 101.8550797108 = -99.9140448709
            //  - costBasis = 100 * (1 - 1%) + 1(fee) = 100
            //  - pnl = 100 + (-99.9140448709) = 0.0859551291
            expect(await clearingHouse.getTotalMarketPnl(maker.address)).to.eq("85955129155713645")
        })

        it("verify maker's pnl when price goes down", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // price after swap: 98.143490128
            // taker
            //  - position size = -1.009413830572328542
            // maker
            //  - position size = 1.009413830572328542
            //  - position value = 1.009413830572328542 * 98.143490128 = 99.0673963158
            //  - costBasis = -99
            //  - pnl = -99 + 99.0673963158 = 0.0673963158
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-67396315840948686")
        })

        it("maker open a long position then verify maker's pnl", async () => {
            // maker open a long position
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })

            // maker before swap:
            //              base    quote
            //   pool       100     10000
            //   pool.fee   n/a     0
            //   CH         9900    0
            //   CH.fee     n/a     0
            //   debt       10000   10000
            //
            //   position size = 100 + 9900 - 10000 = 0
            //   cost basis = 10000 + 0 - 10000 = 0
            //   pnl = 0 + 0 = 0
            //
            // maker after swap:
            //              base            quote
            //   pool       99.0099009901   10099
            //   pool.fee   n/a             1
            //   CH         9900.9900990099 0
            //   CH.fee     n/a             0
            // TODO verify quote debt did increase by 100
            //   debt       10000           10100
            //
            //   position size = 99.0099009901 + 9900.9900990099 - 10000 = 0
            //   cost basis = 10099 + 1 - 10100 = 0
            //   pnl = 0 + 0 = 0
            expect(await clearingHouse.getTotalMarketPnl(maker.address)).to.eq("0")
        })

        it("maker open a short position then verify maker's pnl", async () => {
            // maker open a short position
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
            })

            // maker before swap:
            //              base        quote
            //   pool       100         10000
            //   pool.fee   n/a         0
            //   CH         9900        0
            //   CH.fee     n/a         0
            //   debt       10000       10000
            //
            //   position size = 100 + 9900 - 10000 = 0
            //   cost basis = 10000 + 0 - 10000 = 0
            //   pnl = 0 + 0 = 0
            //
            // maker after swap:
            //              base            quote
            //   pool       101.0101010101  9900
            //   pool.fee   n/a             0
            //   CH         9898.9898989899 99
            //   CH.fee     n/a             1
            //   debt       10000           10000
            //
            //   position size = 101.0101010101 + 9898.9898989899 - 10000 = 0
            //   cost basis = 9900 + 99 + 1 - 10000 = 0
            //   pnl = 0 + 0 = 0

            expect(await clearingHouse.getTotalMarketPnl(maker.address)).to.eq("0")
        })
    })
})
