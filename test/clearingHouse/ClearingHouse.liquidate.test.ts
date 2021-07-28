import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const hundred = toWei(100)
    const ten = toWei(10)
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let baseToken2: TestERC20
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

        describe.skip("carol takeover the position", () => {
            it("swap carol's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
            it("close alice's position")
            it("force error, carol's quote balance is insufficient")
        })

        describe("carol liquidate alice's position", () => {
            it("forcedly close alice's base position", async () => {
                const carolQuoteBefore = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)

                // position size: 0.588407511354640018
                // position value: 0.58840 * ~142.8549872 = 84.085192745971593683
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

                // 84.085192745971593683 * 0.99(1% fee) = 83.2443408185118
                // account value = collateral + pnl = 10 + ( 83.2443408185118 - 90 - 2.1021298186) = 1.1422109998625
                // init margin requirement = 8.857789000137412096 (only quote debt)
                // free collateral = 1.1422109998625 - 8.857789000137412096 * 0.1 = 0.256432099848846695
                expect(await vault.getFreeCollateral(alice.address)).to.eq("256432099848846695")
                const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
                expect(davisTokenInfo.available).to.eq("2102129818649289842")
            })
        })

        it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself", async () => {})
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

        describe("carol liquidate alice's position", () => {
            describe.skip("carol takeover the position", () => {
                it("swap carol's base to alice's quote in a discount (size * marketTWAP * liquidationDiscount)")
                it("close alice's position")
                it("force error, carol's base balance is insufficient")
            })

            it("forcedly close alice's quote position", async () => {
                const carolQuoteBefore = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)

                // position size: -0.600774259337639952
                // position value: -0.600774259337639952 * 158.6340597836 = -95.3032597722
                // pnl = -95.3032597722 + 90 = -5.3032597722
                // account value: 10 + (-5.3032597722) = 4.6967402278
                // fee = 95.3032597722 * 0.025 = 2.3825814943
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

                //  95.337716510326544666 * (1 + 1%) = 96.300723747804590572
                // account value = collateral + pnl = 10 + (-96.300723747804590572 - 2.382581494 + 90) = 1.3166947582
                // init margin requirement = 8.684166660562754188 (only quote debt)
                // free collateral = 1.3166947582 - 8.684166660562754188 * 0.1 = 0.4482780921
                expect(await vault.getFreeCollateral(alice.address)).to.eq("447416673380970394")
                const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
                expect(davisTokenInfo.available).to.eq("2383442912758163616")
            })

            it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund before swap")
        })

        describe("price goes up further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
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
            // position size: 0.294254629696195230
            // position value:  40.638764624332610211
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

            await deposit(alice, vault, 10, collateral)
            // 40.63876 * 0.99(1% fee) = 40.2323724
            // account value = collateral + pnl = 10 + ( 40.2323724(ETH) + 44.5919558(BTC) - 90 - 1.015969) = 3.8083592312
            // init margin requirement =  50.783592137519
            // free collateral = 10 + 3.8083592312 - 50.783592137519  * 0.1 = 8.73000
            expect(await vault.getFreeCollateral(alice.address)).to.eq("8730004479962127225")
            const davisTokenInfo = await clearingHouse.getTokenInfo(davis.address, quoteToken.address)
            expect(davisTokenInfo.available).to.eq("1015969115608315255")
        })

        it("liquidate alice's BTC by carol, even has profit in BTC market", async () => {
            console.log("pnl", (await clearingHouse.getTotalMarketPnl(alice.address)).toString())
            console.log("acc value", (await clearingHouse.getAccountValue(alice.address)).toString())
            console.log((await clearingHouse.getPositionValue(alice.address, baseToken.address, 0)).toString())
            console.log((await clearingHouse.getPositionValue(alice.address, baseToken2.address, 0)).toString())
            console.log((await clearingHouse.getPositionSize(alice.address, baseToken.address)).toString())

            // position size: 0.294254629696195230
            // position value:  44.591955831233061486
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
            const tokenInfo0 = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
            console.log("tokenInfo0", tokenInfo0.available.toString(), tokenInfo0.debt.toString())
            console.log("req.", (await clearingHouse.getTotalOpenOrderMarginRequirement(alice.address)).toString())
            console.log("acc value", (await clearingHouse.getAccountValue(alice.address)).toString())

            await deposit(alice, vault, 10, collateral)
            // 44.58424198139300 * 0.99(1% fee) = 44.1383995616
            // account value = collateral + pnl = 10 + (40.63876(ETH) + 44.13839956(BTC) - 90 - 1.1146) = 3.66255956
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

            // bob short BTC with 10 quote
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken2.address,
                isBaseToQuote: true,
                isExactInput: false,
                amount: toWei("10"),
                sqrtPriceLimitX96: 0,
            })
        })
        it("liquidate alice's ETH by carol", async () => {
            await expect(clearingHouse.connect(carol).liquidate(alice.address, baseToken.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )
        })
        it("liquidate alice's BTC by carol, even has profit in BTC market", async () => {
            await expect(clearingHouse.connect(carol).liquidate(alice.address, baseToken2.address)).to.emit(
                clearingHouse,
                "PositionLiquidated",
            )
        })
    })
})
