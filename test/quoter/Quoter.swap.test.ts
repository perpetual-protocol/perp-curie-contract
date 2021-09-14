import { expect } from "chai"
import { defaultAbiCoder, parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    Quoter,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { BaseQuoteOrdering, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Quoter.swap", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchangeRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let quoter: Quoter
    let lowerTick
    let upperTick

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchangeRegistry = _clearingHouseFixture.exchangeRegistry
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()
        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        await exchangeRegistry.addPool(baseToken.address, "10000")

        const quoterFactory = await ethers.getContractFactory("Quoter")
        quoter = (await quoterFactory.deploy()) as Quoter
        await quoter.initialize(exchangeRegistry.address)

        lowerTick = 49000
        upperTick = 51400

        // prepare maker alice
        await collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("10"),
            quote: parseEther("1500"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // deposit bob's collateral and mint tokens for bob
        // make sure bob always has enough tokens for swap
        await collateral.mint(bob.address, parseUnits("100000", collateralDecimals))
        await deposit(bob, vault, 100000, collateral)
    })

    describe("quote Q2B with exact input", () => {
        it("returns same result with the CH.swap when liquidity is enough", async () => {
            const quoteAmount = parseEther("250")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })

        it("stop swapping and returns same result with CH.swap when price limit reached", async () => {
            // buy base using 500 with price limit of 152
            // the end price would be 157.2470192400286 without the price limit
            const quoteAmount = parseEther("500")
            const priceLimit = encodePriceSqrt(152, 1)

            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableQuote).to.be.lt(quoteAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.eq(swapResponse.deltaAvailableBase)
            expect(quoteResponse.deltaAvailableQuote).to.be.closeTo(swapResponse.deltaAvailableQuote, 1)
            expect(quoteResponse.exchangedPositionSize).to.be.eq(swapResponse.exchangedPositionSize)
            expect(quoteResponse.exchangedPositionNotional).to.be.eq(swapResponse.exchangedPositionNotional)
        })

        it("returns same result with CH.swap when liquidity is not enough", async () => {
            const quoteAmount = parseEther("30000")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableQuote).to.be.lt(quoteAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: true,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.eq(swapResponse.deltaAvailableBase)
            expect(quoteResponse.deltaAvailableQuote).to.be.closeTo(swapResponse.deltaAvailableQuote, 1)
            expect(quoteResponse.exchangedPositionSize).to.be.eq(swapResponse.exchangedPositionSize)
            expect(quoteResponse.exchangedPositionNotional).to.be.eq(swapResponse.exchangedPositionNotional)
        })
    })

    describe("quote Q2B with exact output", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const baseAmount = parseEther("5")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.eq(swapResponse.deltaAvailableBase)
            expect(quoteResponse.deltaAvailableQuote).to.be.closeTo(swapResponse.deltaAvailableQuote, 1)
            expect(quoteResponse.exchangedPositionSize).to.be.eq(swapResponse.exchangedPositionSize)
            expect(quoteResponse.exchangedPositionNotional).to.be.eq(swapResponse.exchangedPositionNotional)
        })

        it("stops swapping and returns same result with CH.swap when price limit reached", async () => {
            // try to buy 5 base token with price limit of 152
            // the end price would be 160.6768890664438 without the price limit
            const baseAmount = parseEther("5")
            const priceLimit = encodePriceSqrt(152, 1)

            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.lt(baseAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // buy base
                isBaseToQuote: false,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.eq(swapResponse.deltaAvailableBase)
            expect(quoteResponse.deltaAvailableQuote).to.be.closeTo(swapResponse.deltaAvailableQuote, 1)
            expect(quoteResponse.exchangedPositionSize).to.be.eq(swapResponse.exchangedPositionSize)
            expect(quoteResponse.exchangedPositionNotional).to.be.eq(swapResponse.exchangedPositionNotional)
        })

        it("force error, unmatched output amount when liquidity is not enough", async () => {
            const baseAmount = parseEther("20")
            await expect(
                quoter.callStatic.swap({
                    baseToken: baseToken.address,
                    // buy base
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: baseAmount,
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("Q_UOA")

            await expect(
                clearingHouse.connect(bob).callStatic.swap({
                    baseToken: baseToken.address,
                    // buy base
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: baseAmount,
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("UB_UOA")
        })
    })

    describe("quote B2Q with exact input", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const baseAmount = parseEther("5")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })

        it("stops swapping and returns same result with CH.swap when price limit reached", async () => {
            // sell 5 base token with price limit of 151
            // the end price would be 142.85498719998498 without the price limit
            const baseAmount = parseEther("5")
            const priceLimit = encodePriceSqrt(151, 1)

            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.lt(baseAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })

        it("returns same result with CH.swap when liquidity is not enough", async () => {
            const baseAmount = parseEther("30")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.lt(baseAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: baseAmount,
                sqrtPriceLimitX96: 0,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })
    })

    describe("quote B2Q with exact output", () => {
        it("returns same result with CH.swap when liquidity is enough", async () => {
            const quoteAmount = parseEther("100")
            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: false,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: false,
                amount: quoteAmount,
                sqrtPriceLimitX96: 0,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })

        it("stops swapping and returns same result with CH.swap when price limit reached", async () => {
            // try to buy 100 quote with price limit of 151
            // the end price would be 149.00824266559061 without the price limit
            const baseAmount = parseEther("200")
            const priceLimit = encodePriceSqrt(151, 1)

            const quoteResponse = await quoter.callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            expect(quoteResponse.deltaAvailableBase).to.be.lt(baseAmount)

            const swapResponse = await clearingHouse.connect(bob).callStatic.swap({
                baseToken: baseToken.address,
                // sell base
                isBaseToQuote: true,
                isExactInput: false,
                amount: baseAmount,
                sqrtPriceLimitX96: priceLimit,
            })
            const partialSwapResponse = [
                swapResponse.deltaAvailableBase,
                swapResponse.deltaAvailableQuote,
                swapResponse.exchangedPositionSize,
                swapResponse.exchangedPositionNotional,
            ]
            expect(quoteResponse).to.be.deep.eq(partialSwapResponse)
        })

        it("force error, unmatched output amount when liquidity is not enough", async () => {
            const quoteAmount = parseEther("3000")
            await expect(
                quoter.callStatic.swap({
                    baseToken: baseToken.address,
                    // sell base
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: quoteAmount,
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("Q_UOA")

            await expect(
                clearingHouse.connect(bob).callStatic.swap({
                    baseToken: baseToken.address,
                    // sell base
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: quoteAmount,
                    sqrtPriceLimitX96: 0,
                }),
            ).revertedWith("UB_UOA")
        })
    })

    describe("Quote.swap in edge cases", async () => {
        it("force error, zero input", async () => {
            await expect(
                quoter.callStatic.swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    // zero input
                    amount: "0",
                    sqrtPriceLimitX96: "0",
                }),
            ).revertedWith("Q_ZI")
        })

        it("force error, 0 liquidity swap", async () => {
            // remove alice's all liquidity
            const aliceOrder = await orderBook
                .connect(alice)
                .getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: aliceOrder.liquidity,
                minBase: "0",
                minQuote: "0",
                deadline: ethers.constants.MaxUint256,
            })

            await expect(
                quoter.callStatic.swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: "100",
                    sqrtPriceLimitX96: "0",
                }),
            ).revertedWith("Q_F0S")
        })

        it("force error, base token not exists", async () => {
            await expect(
                quoter.callStatic.swap({
                    // incorrectly use quote token address
                    baseToken: quoteToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: "100",
                    sqrtPriceLimitX96: "0",
                }),
            ).revertedWith("Q_BTNE")
        })

        it("force error, unexpected call to callback function", async () => {
            await expect(
                quoter.uniswapV3SwapCallback("10", "20", defaultAbiCoder.encode(["address"], [baseToken.address])),
            ).revertedWith("Q_FSV")
        })
    })
})
