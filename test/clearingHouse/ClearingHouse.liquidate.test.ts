import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const hundred = toWei(100)
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let baseToken2: VirtualToken
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        baseToken2 = _clearingHouseFixture.baseToken2
        pool2 = _clearingHouseFixture.pool2
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        mockedBaseAggregator2 = _clearingHouseFixture.mockedBaseAggregator2

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await clearingHouse.addPool(baseToken2.address, 10000)

        // mint
        collateral.mint(alice.address, hundred)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 10, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })
        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        // mint base
        await clearingHouse.connect(carol).mint(baseToken.address, toWei("100"))
        await clearingHouse.connect(carol).mint(baseToken2.address, toWei("100"))
        await clearingHouse.connect(carol).mint(quoteToken.address, toWei("50000"))

        // initialize pool
        await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(15000),
            lowerTick: 49000,
            upperTick: 51400,
        })

        await pool2.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken2.address,
            base: toWei(100),
            quote: toWei(15000),
            lowerTick: 49000,
            upperTick: 51400,
        })
    })

    describe("adjustable parameter", () => {
        it.skip("setLiquidationDiscount")
        it("setLiquidationPenaltyRatio", async () => {
            await clearingHouse.setLiquidationPenaltyRatio(toWei("0.03"))
            expect(await clearingHouse.liquidationPenaltyRatio()).to.eq(toWei("0.03"))
        })
        it("force error, only admin", async () => {
            await expect(clearingHouse.connect(alice).setLiquidationPenaltyRatio(toWei("0.03"))).to.be.revertedWith(
                "Ownable: caller is not the owner",
            )
        })
    })

    describe("alice took long in ETH, price doesn't change", () => {
        it("force error, margin ratio is above the requirement", async () => {
            await clearingHouse.connect(alice).openPosition({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(90),
                sqrtPriceLimitX96: 0,
            })
            await expect(clearingHouse.connect(bob).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
                "CH_EAV",
            )
        })
    })

    describe("alice took long in ETH, bob took short", () => {
        beforeEach(async () => {
            // alice long ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.4780456375

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei("50"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 143.0326798397
        })

        describe("davis liquidate alice's position", () => {
            it("forcedly close alice's base position", async () => {
                // position size: 0.588407511354640018
                // position value: 84.085192745971593683
                // pnl = 84.085192745971593683 - 90 = -5.914807254
                // account value: 10 + (-5.914807254) = 4.085192746
                // fee = 84.085192745971593683 * 0.025 = 2.1021298186
                await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
                    .to.emit(clearingHouse, "PositionLiquidated")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        "84085192745971593683",
                        toWei("0.588407511354640018"),
                        "2102129818649289842",
                        davis.address,
                    )
                // price after liq. 142.8549872

                // deltaAvailableQuote = 84.085192745971593683 * 0.99(1% fee) = 83.2443408185118
                // account value = collateral + pnl = 10 + ( 83.2443408185118 - 90 - 2.1021298186) = 1.1422109998625
                // init margin requirement = 8.857789000137412096 (only quote debt)
                // free collateral = 1.1422109998625 - 8.857789000137412096 * 0.1 = 0.256432099848846695
                expect(await vault.getFreeCollateral(alice.address)).to.eq("256432099848846695")
                const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
                expect(davisTokenInfo.available).to.eq("2102129818649289842")
            })
        })
    })

    // TODO copy the sheet above and make another scenario for short
    describe("alice took short in ETH, bob took long", () => {
        beforeEach(async () => {
            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("90"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice swap : 151.2675469692

            // bob long ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei("40"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 158.6340597836
        })

        it("davis liquidate alice's position", async () => {
            // position size: -0.600774259337639952
            // position value: -95.337716510326544666
            // pnl = -95.3377165103265 + 90 = -5.3032597722
            // account value: 10 + (-5.3032597722) = 4.6967402278
            // fee = 95.3377165103265 * 0.025 = 2.3825814943
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "95337716510326544666",
                    toWei("0.600774259337639952"),
                    "2383442912758163616",
                    davis.address,
                )

            // deltaAvailableQuote = 95.337716510326544666 / 0.99(1% fee) = 96.3007237478
            // account value = collateral + pnl = 10 + (-96.3007237478 - 2.382581494 + 90) = 1.3166947582
            // init margin requirement = 8.684166660562754188 (only quote debt)
            // free collateral = 1.3166947582 - 8.684166660562754188 * 0.1 = 0.4482780921
            expect(await vault.getFreeCollateral(alice.address)).to.eq("447416673380970394")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("2383442912758163616")
        })
    })

    describe("alice took long in ETH and BTC, ETH price goes down", () => {
        beforeEach(async () => {
            // alice long ETH and BTC
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei("45"),
                sqrtPriceLimitX96: 0,
            })
            // ETH price after Alice long: 151.4256717409

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei("45"),
                sqrtPriceLimitX96: 0,
            })
            // BTC price after Alice long: 151.4256717409

            // bob short ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: toWei("80"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob short: 135.0801007405

            // bob long BTC
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob long: 151.54207047
        })
        it("liquidate alice's ETH by davis", async () => {
            // position size of ETH: 0.294254629696195230
            // position value of ETH:  40.638764624332610211
            // pnl =  40.63876(ETH) + 44.5919558312(BTC) - 90 = -4.7625741688
            // account value: 10 + (-4.7625741688) = 5.2374258312
            // fee =  40.63876 * 0.025 = 1.015969
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "40638764624332610211", //  40.63876
                    "294254629696195230", // 0.29
                    "1015969115608315255", //1.015969
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)
            // deltaAvailableQuote of ETH = 40.63876 * 0.99(1% fee) = 40.2323724
            // account value = collateral + pnl = 10 + (40.23237(ETH) + 44.59195(BTC) - 90 - 1.015969) = 3.80835923
            // init margin requirement =  50.783592137519 (only quote debt)
            // free collateral = 10 + 3.80835923 - 50.783592137519  * 0.1 = 8.73000
            expect(await vault.getFreeCollateral(alice.address)).to.eq("8730004479962127225")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1015969115608315255")
        })

        it("liquidate alice's BTC by davis, even has profit in BTC market", async () => {
            // position size of BTC: 0.294254629696195230
            // position value of BTC:  44.591955831233061486
            // pnl =  40.63876(ETH) + 44.591955831233(BTC) - 90 = -4.76256667585
            // account value: 10 + (-4.76256667585) = 5.2374258312
            // fee =  44.584 * 0.025 = 1.1146
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken2.address,
                    "44584241981393002740", //  44.584
                    "294254629696195230", // 0.29
                    "1114606049534825068", //1.1146
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)
            // deltaAvailableQuote of BTC = 44.58424198139300 * 0.99(1% fee) = 44.1383995616
            // account value = collateral + pnl = 10 + (40.63876(ETH) + 44.138399(BTC) - 90 - 1.1146) = 3.66255956
            // init margin requirement =  46.97620648795575235
            // free collateral = 10 + 3.66255956 - 46.9762064879557523 * 0.1 = 8.9649389
            expect(await vault.getFreeCollateral(alice.address)).to.eq("8971650356163031408")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1114606049534825068")
        })
    })

    describe("alice took short in ETH and BTC, ETH price go down", () => {
        beforeEach(async () => {
            // alice short ETH
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("45"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice short, 151.3198881742

            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("45"),
                sqrtPriceLimitX96: 0,
            })
            // price after Alice short, 151.3198881742

            // bob long 80 ETH
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                amount: toWei("80"),
                sqrtPriceLimitX96: 0,
            })
            // price after bob swap : 166.6150230501

            // bob short BTC with 100 quote
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("100"),
                sqrtPriceLimitX96: 0,
            })
            // price after Bob short, 151.20121364648824
        })
        it("liquidate alice's ETH by davis", async () => {
            // position size of ETH: -0.300334113234575750
            // position value of ETH: -50.040175199
            // pnl = -50.040175199 +(-45.41088242) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 50.040175199 * 0.025 = 1.25100438
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    "50049442662484937695",
                    "300334113234575750",
                    "1251236066562123442",
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)

            // deltaAvailableQuote of ETH = 50.04944266248 / 0.99 (1% fee) = 50.549937089
            // account value = collateral + pnl = 10 + (-45.41088242 - 50.549937089 - 1.25100438 + 90) = 2.78817
            // init margin requirement = 0.300334(debt of BTC) * 100 (index price) = 30.033411323
            // free collateral = 2.78817 + 10 - 30.033411323 * 0.1 = 9.7795
            expect(await vault.getFreeCollateral(alice.address)).to.eq("9779547792213811030")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1251236066562123442")
        })

        it("liquidate alice's BTC by davis, even has profit in BTC market", async () => {
            // position size of BTC: -0.300334113234575750
            // position value of BTC: -45.410882420509684093
            // pnl = -50.040175199 +(-45.4188940109116) + 90 = -5.459069
            // account value: 10 + (-5.459069) = 4.540931
            // fee = 45.4188940 * 0.025 = 1.135472350272790574
            await expect(clearingHouse.connect(davis).liquidate(alice.address, baseToken2.address))
                .to.emit(clearingHouse, "PositionLiquidated")
                .withArgs(
                    alice.address,
                    baseToken2.address,
                    "45418894010911622979",
                    "300334113234575750",
                    "1135472350272790574",
                    davis.address,
                )

            // hard to have a good enough price to liquidate Alice and have non-zero free collateral after liquidation
            // so add more collateral.
            await deposit(alice, vault, 10, collateral)
            // deltaAvailableQuote of BTC = 45.4188940 * (1 + 1%) = 45.87308294
            // account value = collateral + pnl = 10 + (-45.8730829 - 50.040175199 - 1.135472350 + 90) = 2.9512695
            // init margin requirement = 0.30033411323(debt of ETH) * 100(index price) = 30.033411323
            // free collateral = 2.9512695 + 10 - 30.033411323 * 0.1 = 9.9479283677
            expect(await vault.getFreeCollateral(alice.address)).to.eq("9943340599976214434")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1135472350272790574")
        })
    })

    describe.skip("V2 liquidator takes trader's position", () => {
        describe("davis takeover the position", () => {
            it("swap davis's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
            it("close alice's position")
            it("force error, davis's quote balance is insufficient")
        })
        it("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it("liquidate alice's position partially by davis")
        })
    })
})
