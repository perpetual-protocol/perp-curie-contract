import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, TestAccountBalance, TestClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { mockIndexPrice, syncIndexToMarketPrice } from "../shared/utilities"

import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { DECIMAL_PLACES_18 } from "../shared/constant"
import { forwardBothTimestamps } from "../shared/time"

describe("AccountBalance.getTotalPositionValue", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let mockedPriceFeedDispatcher: MockContract

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        // alice
        await collateral.mint(alice.address, parseUnits("10000", collateralDecimals))
        await deposit(alice, vault, 10000, collateral)

        // bob
        await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
        await deposit(bob, vault, 1000, collateral)

        // carol
        await collateral.mint(carol.address, parseUnits("1000", collateralDecimals))
        await deposit(carol, vault, 1000, collateral)
    })

    describe("initialized price = 151.3733069", () => {
        beforeEach(async () => {
            const initPrice = "151.3733069"
            await initMarket(fixture, initPrice)
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
        })

        // see more desc in getTotalPositionSize test
        it("value = 0, if position size = 0", async () => {
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await accountBalance.getTotalPositionValue(alice.address, baseToken.address)).eq(0)

            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(0)
            expect(await accountBalance.getTotalPositionValue(alice.address, baseToken.address)).eq(0)
        })

        it("bob(taker) swaps 1 time", async () => {
            // provide 1000 liquidity = 1000 * 0.122414646 = 122.414646
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob short 0.4084104205
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.4084104205"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // B2QFee: Bob is down 0.4084104205 base tokens and Alice received it full because she's the sole LP
            // Note CH actually shorts 0.4084104205 / 0.99 = 0.4125357783 base tokens
            // but the extra tokens have been collected as base token fees and does not count toward Alice's position size.

            // which makes the mark price become 149.863446 (tick = 50099.75001)

            // if we get sqrtMarkTwapX96 with timeInterval == 0, the value should be same as the initial price = 151.3733069
            // await exchange.getSqrtMarketTwapX96(baseToken.address, 0)).toString() == 11993028956124528295336454433927
            // (11993028956124528295336454433927 / 2^96) = 151.3733068587
            // -> no need to pow(151.3733068587, 2) here as the initial value is already powered in their system, for unknown reason

            // default timeInterval is 15 minutes = 900 seconds
            await forwardBothTimestamps(clearingHouse, 900)

            // (969864706335398656864177991756 / 2^96) ^ 2 = 149.8522069973
            // 149.8522069973 != 149.863446, the reason is:
            // tickCumulative inside their system uses "integer" tick
            // thus,
            // 1. instead of the exact mark price 149.863446, whose tick index is 50099.75001 -> floor() -> 50099
            // 2. when considering the accumulator, we also need floor(): (50099 * 900 / 900) = 50099 -> floor() -> 50099
            // -> 1.0001 ^ 50099 = 149.8522069974
            await mockIndexPrice(mockedPriceFeedDispatcher, "149.852206")

            const markPrice = await accountBalance.getMarkPrice(baseToken.address)
            // current mark price: 149.863445975554800998

            const alicePositionSize = parseEther("0.408410420499999999")
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(alicePositionSize)
            expect(await accountBalance.getTotalPositionValue(alice.address, baseToken.address)).eq(
                alicePositionSize.mul(markPrice).div(DECIMAL_PLACES_18),
            )

            const bobPositionSize = parseEther("-0.4084104205")
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(bobPositionSize)
            expect(await accountBalance.getTotalPositionValue(bob.address, baseToken.address)).eq(
                bobPositionSize.mul(markPrice).div(DECIMAL_PLACES_18),
            )
        })

        it("bob swaps 2 time", async () => {
            // provide 1000 liquidity = 1000 * 0.122414646 = 122.414646
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("122.414646"),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // bob shorts 0.2042052103
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.2042052103"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // market price should be 150.6155385 (tick = 50149.8122)

            await forwardBothTimestamps(clearingHouse, 300)

            // bob shorts 0.2042052103
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.2042052103"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // B2QFee: Bob is down 0.4084104205 base tokens and Alice received it full because she's the sole LP
            // Note CH actually shorts 0.2042052103 * 2 / 0.99 = 0.4125357784 base tokens
            // but the extra tokens have been collected as base token fees and does not count toward Alice's position size.

            // which makes the market price become 149.863446 (tick = 50099.75001)

            await forwardBothTimestamps(clearingHouse, 600)

            // (970640869716903962852171321230 / 2^96) ^ 2 = 150.0921504352
            // ((50149 * 300 + 50099 * 600) / 900) = 50115.6666666667 -> floor() -> 50115
            // -> 1.0001 ^ 50115 = 150.0921504352

            await mockIndexPrice(mockedPriceFeedDispatcher, "150.092150")
            // expect(await exchange.getSqrtMarketTwapX96(baseToken.address, 900)).eq("970640869716903962852171321230")

            const markPrice = await accountBalance.getMarkPrice(baseToken.address)
            // current mark price: 150.092150435211957755

            const alicePositionSize = parseEther("0.408410420599999999")
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(alicePositionSize)
            expect(await accountBalance.getTotalPositionValue(alice.address, baseToken.address)).eq(
                alicePositionSize.mul(markPrice).div(DECIMAL_PLACES_18),
            )

            // short
            const bobPositionSize = parseEther("-0.4084104206")
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(bobPositionSize)
            expect(await accountBalance.getTotalPositionValue(bob.address, baseToken.address)).eq(
                bobPositionSize.mul(markPrice).div(DECIMAL_PLACES_18),
            )
        })
    })

    it("bob swaps 2 time, while the second time is out of carol's range", async () => {
        const initPrice = "148.3760629"
        await initMarket(fixture, initPrice)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        const lowerTick = "50000"
        const middleTick = "50200"
        const upperTick = "50400"
        const baseIn50000And50200 = 0.816820841
        const baseIn50200And50400 = 0.8086937422

        // add base
        // 0.816820841 + 0.8086937422 = 1.625514583
        const addLiquidityParamsAlice = {
            baseToken: baseToken.address,
            lowerTick: lowerTick, // 148.3760629
            upperTick: upperTick, // 154.4310961
            base: parseEther((baseIn50000And50200 + baseIn50200And50400).toString()),
            quote: "0",
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        }
        await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

        // add base
        const addLiquidityParamsCarol = {
            baseToken: baseToken.address,
            lowerTick: lowerTick, // 148.3760629
            upperTick: middleTick, // 151.3733069
            base: parseEther(baseIn50000And50200.toString()),
            quote: "0",
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        }
        await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

        // bob wants to swap
        // quote: (244.829292 + 98.91589745) / 0.99 = 247.3023151515 + 99.9150479293 = 347.2173633
        // to base: 1.633641682 + 0.6482449586 = 2.281886641

        // first swap: 247.3023151515 quote to 1.633641682 base
        const swapParams1 = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("247.3023151515"),
            sqrtPriceLimitX96: "0",
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }
        await clearingHouse.connect(bob).openPosition(swapParams1)
        // market price should be 151.3733069 (tick = 50200)

        await forwardBothTimestamps(clearingHouse, 400)

        // second swap: 99.9150479293 quote to 0.6482449586 base
        const swapParams2 = {
            baseToken: baseToken.address,
            isBaseToQuote: false,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("99.9150479293"),
            sqrtPriceLimitX96: "0",
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        }
        await clearingHouse.connect(bob).openPosition(swapParams2)
        // market price should be 153.8170921 (tick = 50360.15967)

        await forwardBothTimestamps(clearingHouse, 500)

        // (979072907636267862275708019389 / 2^96) ^ 2 = 152.7112031757
        // ((50200 * 400 + 50360 * 500) / 900) = 50288.8888888889 -> floor() -> 50288
        // -> 1.0001 ^ 50288 = 152.7112031757

        await mockIndexPrice(mockedPriceFeedDispatcher, "152.711203")
        // expect(await exchange.getSqrtMarketTwapX96(baseToken.address, 900)).eq("979072907636267862275708019389")

        // current mark price:  148.361226800394579524

        // -(1.633641682 / 2 + 0.6482449586) = -1.4650657996
        expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
            parseEther("-1.465065799750044640"),
        )

        // 148.361226800394579524 * -1.465065799750044640 = -217.3589593942
        expect(await accountBalance.getTotalPositionValue(alice.address, baseToken.address)).eq(
            parseEther("-217.358959394217841111"),
        )

        // 1.633641682 + 0.6482449586 = 2.2818866406
        expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(
            parseEther("2.281886640750044638"),
        )
        // 148.361226800394579524 * 2.281886640750044638 = 338.5435014411
        expect(await accountBalance.getTotalPositionValue(bob.address, baseToken.address)).eq(
            parseEther("338.543501441107880392"),
        )

        // -1.633641682 / 2 = -0.816820841
        expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(
            parseEther("-0.816820841"),
        )
        // 148.361226800394579524 * -0.816820841 = -121.1845420469
        expect(await accountBalance.getTotalPositionValue(carol.address, baseToken.address)).eq(
            parseEther("-121.184542046890039578"),
        )
    })
})
