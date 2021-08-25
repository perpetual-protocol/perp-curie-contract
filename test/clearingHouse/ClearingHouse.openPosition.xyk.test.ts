import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { Exchange, TestClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchange = _clearingHouseFixture.exchange
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

        await pool.initialize(encodePriceSqrt("10", "1"))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        await exchange.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("100"))
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("1000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
        await deposit(taker, vault, 1000, collateral)

        // expect all available and debt are zero
        const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
        const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
        expect(baseInfo.available.eq(0)).to.be.true
        expect(baseInfo.debt.eq(0)).to.be.true
        expect(quoteInfo.available.eq(0)).to.be.true
        expect(quoteInfo.debt.eq(0)).to.be.true
    })

    // https://docs.google.com/spreadsheets/d/1QwN_UZOiASv3dPBP7bNVdLR_GTaZGUrHW3-29ttMbLs/edit#gid=238402888
    describe("taker open position from zero", () => {
        afterEach(async () => {
            expect(await clearingHouse.getOwedRealizedPnl(taker.address)).eq(parseEther("0"))
        })

        it("increase positionSize and openNotional (negative for long) - exactInput", async () => {
            // taker swap exact 250 USD for 19.84 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(
                parseEther("19.839679358717434869"),
            )
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("-250"))
        })

        it("increase positionSize and openNotional (negative for long) - exactOutput", async () => {
            // taker swap 252.53 USD for exact 20 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("20"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("20"))
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).closeTo(
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
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        })

        it("increase -positionSize and openNotional (positive for short) - exactOutput", async () => {
            // taker swap exact 25 ETH for 198 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-25"))
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("198"))
        })
    })

    describe("opens long then", () => {
        beforeEach(async () => {
            // taker swap 252.53 USD for exact 20 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("20"),
                sqrtPriceLimitX96: 0,
            })
        })

        describe("open another long", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("20"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("increase positionSize and openNotional", async () => {
                expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("40"))

                expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).closeTo(
                    parseEther("-673.400673400673400666"),
                    2,
                )

                expect(await clearingHouse.getOwedRealizedPnl(taker.address)).eq("0")
            })
        })

        describe("reduce half long", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("10"))
                // 252.525252525252525252 / 2 = 126.2626262626
                expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(
                    parseEther("-126.262626262626262626"),
                )
                // this will be weirdly positive because of the nature of the average open notional pricing
                // expect(await clearingHouse.getOwedRealizedPnl(taker.address)).eq()
            })

            it("has loss when closed the pos", async () => {
                const pos = await clearingHouse.getPositionSize(taker.address, baseToken.address)
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: pos,
                    sqrtPriceLimitX96: 0,
                })
                expect(await clearingHouse.getOwedRealizedPnl(taker.address)).closeTo(
                    parseEther("-5.025252525252525255"),
                    2,
                )
            })
        })

        it("larger reverse short", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("30"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-10"))
            // trader's actual delta = 340.91 - 3.41 = 337.5
            // notional of original 20 ETH = 337.5 / 3 * 2 = 252.525252
            // remain 10 ETH's notional = openNotional = 337.5 - 252.5252 = 112.5
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("112.5"))
        })
    })

    describe("opens short then", () => {
        beforeEach(async () => {
            // taker swap exact 25 ETH for 198 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
            })
        })

        describe("reduce half short", () => {
            beforeEach(async () => {
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: parseEther("12.5"),
                    sqrtPriceLimitX96: 0,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("-12.5"))
                // 198/2 = 99
                expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(parseEther("99"))
                // this will be weirdly positive because of the nature of the average open notional pricing
                // expect(await clearingHouse.getOwedRealizedPnl(taker.address)).eq()
            })

            it("has loss when closed the pos", async () => {
                const pos = await clearingHouse.getPositionSize(taker.address, baseToken.address)
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    amount: pos.abs(),
                    sqrtPriceLimitX96: 0,
                })
                // should be exact -4?
                expect(await clearingHouse.getOwedRealizedPnl(taker.address)).closeTo(
                    parseEther("-4.020202020202020203"),
                    2,
                )
            })
        })

        it("larger reverse long", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: parseEther("40"),
                sqrtPriceLimitX96: 0,
            })
            expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).eq(parseEther("15"))
            // 142.58823529
            expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("-142.602495543672014261"),
            )
        })
    })
})
