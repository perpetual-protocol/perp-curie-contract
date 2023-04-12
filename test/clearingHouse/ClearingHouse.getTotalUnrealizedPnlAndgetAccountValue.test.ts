import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, TestAccountBalance, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice, mockMarkPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse getTotalUnrealizedPnl & getAccountValue", () => {
    const [admin, maker, taker, taker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let makerCollateral: BigNumber
    let takerCollateral: BigNumber
    let totalUnrealizedPnl: string
    let totalUnrealizedPnlInCollateralDecimals: string

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "100"
        await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        // prepare collateral for maker
        makerCollateral = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateral)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("10000"),
            lowerTick: 0,
            upperTick: 100000,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        takerCollateral = parseUnits("10000", collateralDecimals)

        // prepare collateral for taker
        await collateral.mint(taker.address, takerCollateral)
        await deposit(taker, vault, 10000, collateral)

        // prepare collateral for taker2
        await collateral.mint(taker2.address, takerCollateral)
        await deposit(taker2, vault, 10000, collateral)
    })

    describe("taker", () => {
        it("takers long", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "101.855079")

            // price after swap: 101.855079
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.855079 = 99.9140441736
            // open notional = -100
            // pnl = -100 + 99.9140441736 = -0.0859558264
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).to.eq(
                parseEther("-100"),
            )

            totalUnrealizedPnl = "-0.085955826385873143"
            totalUnrealizedPnlInCollateralDecimals = "-0.085956"
            const [, takerUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            const takerCollateralX18 = parseUnits(takerCollateral.toString(), 18 - collateralDecimals)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "103.727208")

            // price after swap: 103.727208
            // taker1
            // position value = 0.980943170969551031 * 103.727208 = 101.7504963313
            // pnl = -100 + 101.7504963313 = 1.7504963313
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).to.eq(
                parseEther("-100"),
            )

            totalUnrealizedPnl = "1.750496331338181459"
            const [, takerAfterUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerAfterUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = parseFloat(totalUnrealizedPnl).toFixed(collateralDecimals)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })

        it("takers long and then short", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "101.855079")

            // price after swap: 101.855079
            // position size = 0.980943170969551031
            // position value = 0.980943170969551031 * 101.855079 = 99.9140441736
            // open notional = -100
            // pnl = -100 + 99.9140441736 = -0.0859558264
            totalUnrealizedPnl = "-0.085955826385873143"
            const [, takerUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "-0.085956"
            const takerCollateralX18 = parseUnits(takerCollateral.toString(), 18 - collateralDecimals)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "98.125012")

            // price after swap: 98.125012
            // taker1
            // position value = 0.980943170969551031 * 98.125012 = 96.2550604227
            // pnl = -100 + 96.2550604227 = -3.7449395773
            totalUnrealizedPnl = "-3.744939577294753449"
            const [, takerAfterUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerAfterUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "-3.744940"
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })

        it("takers short and then long", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "98.143490")

            // price after swap: 98.143490
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490 = -99.0673961866
            // net quote amount = 99
            // pnl = 99 + -99.0673961866 = -0.0673961866
            totalUnrealizedPnl = "-0.067396186637020538"
            const [, takerUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "-0.067397"
            const takerCollateralX18 = parseUnits(takerCollateral.toString(), 18 - collateralDecimals)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )

            // taker2 open a long position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "99.981348")

            // price after swap: 99.981348
            // taker1
            // position value = -1.009413830572328542 * 99.981348 = -100.9225554705
            // pnl = 99 + -100.9225554705 = -1.9225554705
            totalUnrealizedPnl = "-1.922555470465019128"
            const [, takerAfterUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerAfterUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "-1.922556"
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })

        it("takers short", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "98.143490")

            // price after swap: 98.143490
            // position size = -1.009413830572328542
            // position value = -1.009413830572328542 * 98.143490 = -99.0673961866
            // open notional = 99
            // pnl = 99 + -99.0673961866 = -0.0673961866
            totalUnrealizedPnl = "-0.067396186637020538"
            const [, takerUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "-0.067397"
            const takerCollateralX18 = parseUnits(takerCollateral.toString(), 18 - collateralDecimals)
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )

            // taker2 open a short position
            await clearingHouse.connect(taker2).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("198"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // B2QFee: CH actually shorts 198 / 0.99 = 200

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "94.446032")

            // price after swap: 94.446032
            // taker1
            // position value = -1.009413830572328542 * 94.446032 = -95.3351309435
            // pnl = 99 + -95.3351309435 = 3.6648690565
            totalUnrealizedPnl = "3.664869056523280208"
            const [, takerAfterUnrealizedPnl] = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(takerAfterUnrealizedPnl).to.eq(parseEther(totalUnrealizedPnl))

            totalUnrealizedPnlInCollateralDecimals = "3.664869"
            expect(await clearingHouse.getAccountValue(taker.address)).to.be.closeTo(
                takerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })
    })

    describe("maker", () => {
        it("long", async () => {
            // taker1 open a long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("100"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "101.855079")

            // price after swap: 101.855079
            // taker
            //  - position size = 0.980943170969551031
            // maker
            //  - position size = -0.980943170969551031
            //  - position value = -0.980943170969551031 * 101.855079 = -99.9140441736
            //  - open notional = 100 * (1 - 1%) + 1(fee) = 100
            //  - pnl = 100 + (-99.9140441736) = 0.0859558264

            totalUnrealizedPnl = "0.085955826385873040"
            const makerTotalOpenNotional = await accountBalance.getTotalOpenNotional(maker.address, baseToken.address)
            const [, makerUnrealizedPnl, makerFee] = await accountBalance.getPnlAndPendingFee(maker.address)
            expect(makerUnrealizedPnl.add(makerFee)).to.be.closeTo(parseEther(totalUnrealizedPnl), 10)
            expect(makerTotalOpenNotional.add(makerFee)).to.be.closeTo(parseEther("100"), 2)
            const makerCollateralX18 = parseUnits(makerCollateral.toString(), 18 - collateralDecimals)

            totalUnrealizedPnlInCollateralDecimals = "0.085955"
            expect(await clearingHouse.getAccountValue(maker.address)).to.be.closeTo(
                makerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })

        it("short", async () => {
            // taker1 open a short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("99"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // B2QFee: CH actually shorts 99 / 0.99 = 100

            // mock mark price to make calculation simpler
            await mockMarkPrice(accountBalance, baseToken.address, "98.143490")

            // price after swap: 98.143490
            // taker
            //  - position size = -1.009413830572328542
            // maker
            //  - position size = 1.009413830572328542
            //  - position value = 1.009413830572328542 * 98.143490 = 99.0673961866
            //  - open notional = -99
            //  - pnl = -99 + 99.0673961866 = 0.0673961866

            totalUnrealizedPnl = "0.067396186637020438"
            const makerTotalOpenNotional = await accountBalance.getTotalOpenNotional(maker.address, baseToken.address)
            const [, makerUnrealizedPnl, makerFee] = await accountBalance.getPnlAndPendingFee(maker.address)
            expect(makerUnrealizedPnl.add(makerFee)).to.be.closeTo(parseEther(totalUnrealizedPnl), 10)
            expect(makerTotalOpenNotional.add(makerFee)).to.be.closeTo(parseEther("-99"), 2)

            totalUnrealizedPnlInCollateralDecimals = "0.067396"
            const makerCollateralX18 = parseUnits(makerCollateral.toString(), 18 - collateralDecimals)
            expect(await clearingHouse.getAccountValue(maker.address)).to.be.closeTo(
                makerCollateralX18.add(parseEther(totalUnrealizedPnlInCollateralDecimals)),
                1,
            )
        })

        describe("maker's pnl should remain 0 after opening a position", () => {
            it("long", async () => {
                // maker open a long position
                await clearingHouse.connect(maker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("100"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
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
                //   open notional = 10000 + 0 - 10000 = 0
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
                //   open notional = 10099 + 1 - 10100 = 0
                //   pnl = 0 + 0 = 0
                const [, makerUnrealizedPnl, makerFee] = await accountBalance.getPnlAndPendingFee(maker.address)

                expect(makerUnrealizedPnl.add(makerFee)).to.be.closeTo("0", 10)
                expect((await clearingHouse.getAccountValue(maker.address)).div(1e12)).to.be.closeTo(makerCollateral, 2)
            })

            it("short", async () => {
                // maker open a short position
                await clearingHouse.connect(maker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("99"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
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
                //   open notional = 10000 + 0 - 10000 = 0
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
                //   open notional = 9900 + 99 + 1 - 10000 = 0
                //   pnl = 0 + 0 = 0
                const [, makerUnrealizedPnl, makerFee] = await accountBalance.getPnlAndPendingFee(maker.address)
                expect(makerUnrealizedPnl.add(makerFee)).to.be.closeTo("0", 10)
                expect((await clearingHouse.getAccountValue(maker.address)).div(1e12)).to.be.closeTo(makerCollateral, 2)
            })
        })
    })
})
