import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getTotalMarketPnl", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
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
        vault = _clearingHouseFixture.vault
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
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, toWei(10000))
        await clearingHouse.connect(maker).mint(quoteToken.address, toWei(10000))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(10000),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = toWei(10000, collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await deposit(taker, vault, 10000, collateral)

        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await deposit(taker2, vault, 10000, collateral)
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
                amount: parseEther("200"),
                sqrtPriceLimitX96: 0,
            })

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
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 98.143490128
            // position size = -1.019609929871038932
            // position value = -1.019609929871038932 * 98.143490128 = -100.0680770867
            // cost basis = 100
            // pnl = 100 - 100.0680770867= -0.0680770867
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-68077086708029043")

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
            // position value = -1.019609929871038932 * 99.9813487961 = -101.9419760344
            // pnl = 100 + -101.9419760344 = -1.9419760344
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-1941976034369196531")
        })

        it("taker open short and price goes down", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 98.143490128
            // position size = -1.019609929871038932
            // position value = -1.019609929871038932 * 98.143490128 = -100.0680770867
            // cost basis = 100
            // pnl = 100 - 100.0680770867= -0.0680770867
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-68077086708029043")

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("200"),
                sqrtPriceLimitX96: 0,
            })

            // price after swap: 94.4826553619
            // taker1
            // position value = -1.019609929871038932 * 94.4826553619 = -96.3354536076
            // pnl = 100 + -96.3354536076 = 3.6645463924
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("3664546392424288912")
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
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after swap: 98.143490128
            // taker
            //  - position size = -1.019609929871038932
            // maker
            //  - position size = 1.019609929871038932
            //  - position value = 1.019609929871038932 * 98.143490128 = 100.0680770867
            //  - costBasis = -100
            //  - pnl = -100 + 100.0680770867 = 0.0680770867
            expect(await clearingHouse.getTotalMarketPnl(taker.address)).to.eq("-68077086708029043")
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
            expect(await clearingHouse.getTotalMarketPnl(maker.address)).to.eq("0")
        })

        it("maker open a short position then verify maker's pnl", async () => {
            // maker open a short position
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getTotalMarketPnl(maker.address)).to.eq("0")
        })
    })
})
