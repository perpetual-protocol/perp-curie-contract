import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { AccountBalance, BaseToken, TestClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition in xyk pool", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number
    let pool: UniswapV3Pool

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

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
            // taker swap exact 25 USD for 2.4152232252 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(
                parseEther("2.415223225176872407"),
            )
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(parseEther("-25"))
        })

        it("increase positionSize and openNotional (negative for long) - exactOutput", async () => {
            // taker swap 20.614 USD for exact 2 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("2"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).closeTo(
                parseEther("-20.614306328592042878"),
                1,
            )
        })

        it("increase -positionSize and openNotional (positive for short) - exactInput", async () => {
            // taker swap exact 2 ETH for 19.411764705882352940 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-2"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("19.411764705882352940"),
            )
        })

        it("increase -positionSize and openNotional (positive for short) - exactOutput", async () => {
            // taker swap exact 2 ETH for 19.411764705882352940 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("19.411764705882352940"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-2"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("19.411764705882352940"),
            )
        })
    })

    describe("opens long then", () => {
        beforeEach(async () => {
            // taker swap 20.6143063286 USD for exact 2 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })

        describe("open another long", () => {
            beforeEach(async () => {
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("increase positionSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("4"))

                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                    parseEther("-42.087542087542087543"),
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
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("1"))
                // 20.6143063286 / 2 = 10.3071531643
                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                    parseEther("-10.307153164296021439"),
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
                expect(pnl[0]).closeTo(parseEther("-0.410224695938981656"), 2)
            })
        })

        it("larger reverse short", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("4"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-2"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("19.807923169267707082"),
            )
        })
    })

    describe("opens short then", () => {
        beforeEach(async () => {
            // taker swap exact 2 ETH for 19.411 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
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
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
            })

            it("half the posSize and openNotional", async () => {
                expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("-1"))
                // 19.411/2 = 9.7055
                expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                    parseEther("9.705882352941176470"),
                )
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

                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).closeTo(parseEther("-0.394137452960982377"), 2)
            })
        })

        it("larger reverse long", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("4"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).eq(parseEther("2"))
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).eq(
                parseEther("-20.210104243717689096"),
            )
        })
    })
})
