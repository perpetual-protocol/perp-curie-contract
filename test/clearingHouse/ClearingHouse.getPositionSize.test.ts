import { MockContract } from "@eth-optimism/smock"
import { parseEther } from "@ethersproject/units"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { AccountBalance, BaseToken, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.getTotalPositionSize", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

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

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918

    describe("initialized price = 151.3733069", () => {
        beforeEach(async () => {
            const initPrice = "151.3733069"
            await initMarket(fixture, initPrice)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")
        })

        it("size = 0, if no swap", async () => {
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(0)

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

            // The swap pushes the mark price to 149.863446 (tick = 50099.75001)

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("0.408410420499999999"),
            )

            // 0.4084104205
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(
                parseEther("-0.4084104205"),
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
            // mark price should be 150.6155385 (tick = 50149.8122)

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

            // which makes the mark price become 149.863446 (tick = 50099.75001)

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("0.408410420599999999"),
            )

            // 0.2042052103 * 2 = 0.4084104206
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(
                parseEther("-0.4084104206"),
            )
        })
    })

    // see "out of maker's range; alice receives more fee as the price goes beyond carol's range" in ClearingHouse.removeLiquidity.test.ts
    it("bob swaps 2 time, while the second time is out of carol's range", async () => {
        const initPrice = "148.3760629"
        await initMarket(fixture, initPrice)
        await mockIndexPrice(mockedPriceFeedDispatcher, "148")

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
        // mark price should be 151.3733069 (tick = 50200)

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
        // mark price should be 153.8170921 (tick = 50360.15967)

        // -(1.633641682 / 2 + 0.6482449586) = -1.4650657996
        expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
            parseEther("-1.465065799750044640"),
        )

        // 1.633641682 + 0.6482449586 = 2.2818866406
        expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).eq(
            parseEther("2.281886640750044638"),
        )

        // -1.633641682 / 2 = -0.816820841
        expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(
            parseEther("-0.816820841"),
        )
    })
})
