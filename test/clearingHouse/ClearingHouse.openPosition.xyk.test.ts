import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTick, getMaxTickRange, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })

        await initAndAddPool(
            _clearingHouseFixture,
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

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 1000, collateral)

        // expect all available and debt are zero
        const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
        expect(baseBalance).be.deep.eq(parseEther("0"))
        expect(quoteBalance).be.deep.eq(parseEther("0"))
    })

    // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=238402888
    describe("taker open position from zero", () => {
        afterEach(async () => {
            const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(pnl[0]).eq(parseEther("0"))
        })

        it("increase positionSize and openNotional (negative for long) - exactInput", async () => {
            // taker swap exact 250 USD for 19.84 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(
                parseEther("19.839679358717434869"),
            )
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("-250"))
        })

        it("increase positionSize and openNotional (negative for long) - exactOutput", async () => {
            // taker swap 252.53 USD for exact 20 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("20"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("20"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).closeTo(
                parseEther("-252.525252525252525252"),
                1,
            )
        })

        it("increase -positionSize and openNotional (positive for short) - exactInput", async () => {
            // taker swap exact 25 ETH for 198 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        })

        it("increase -positionSize and openNotional (positive for short) - exactOutput", async () => {
            // taker swap exact 25 ETH for 198 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        })
    })

    describe("opens long then", () => {
        beforeEach(async () => {
            // taker swap 252.53 USD for exact 20 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("20"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        describe("open another long", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("increase positionSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("40"))

                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).closeTo(
                    parseEther("-673.400673400673400666"),
                    2,
                )

                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).eq("0")
            })
        })

        describe("reduce half long", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("10"))
                // 252.525252525252525252 / 2 = 126.2626262626
                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                    parseEther("-126.262626262626262626"),
                )
                // this will be weirdly positive because of the nature of the average open notional pricing
                // expect(await accountBalance.getPnlAndPendingFee(taker.address)).eq()
            })

            it("has loss when closed the pos", async () => {
                const pos = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: pos,
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).closeTo(parseEther("-5.025252525252525255"), 2)
            })
        })

        it("larger reverse short", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("30"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-10"))
            // trader's actual delta = 340.91 - 3.41 = 337.5
            // notional of original 20 ETH = 337.5 / 3 * 2 = 252.525252
            // remain 10 ETH's notional = openNotional = 337.5 - 252.5252 = 112.5
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("112.5"))
        })
    })

    describe("opens short then", () => {
        beforeEach(async () => {
            // taker swap exact 25 ETH for 198 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        describe("reduce half short", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("12.5"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(
                    parseEther("-12.5"),
                )
                // 198/2 = 99
                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("99"))
                // this will be weirdly positive because of the nature of the average open notional pricing
                // expect(await accountBalance.getPnlAndPendingFee(taker.address)).eq()
            })

            it("has loss when closed the pos", async () => {
                const pos = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: pos.abs(),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // should be exact -4?
                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).closeTo(parseEther("-4.020202020202020203"), 2)
            })
        })

        it("larger reverse long", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("40"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("15"))
            // 142.58823529
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("-142.602495543672014261"),
            )
        })
    })
})
