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
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
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

        // mint base
        await clearingHouse.connect(carol).mint(baseToken.address, toWei("100"))
        await clearingHouse.connect(carol).mint(quoteToken.address, toWei("15000"))

        // initialize pool
        // Add liquidity in tick range (50000, 50400)
        // L = 10000.000048914464937798, y = 8.16820845
        await pool.initialize(encodePriceSqrt("151.3733069", "1"))
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: toWei(100),
            quote: toWei(15000),
            lowerTick: 50000,
            upperTick: 50400,
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
            await clearingHouse.connect(alice).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: toWei(100),
                sqrtPriceLimitX96: 0,
            })
            await expect(clearingHouse.connect(bob).liquidate(alice.address, baseToken.address)).to.be.revertedWith(
                "CH_EAV",
            )
        })
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    // Two takers; has PnL
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

            // bob short ETH
            // await clearingHouse.connect(bob).openPosition({
            //     baseToken: baseToken.address,
            //     isBaseToQuote: true,
            //     isExactInput: true,
            //     amount: toWei("100"),
            //     sqrtPriceLimitX96: 0,
            // })
        })

        describe("carol liquidate alice's position", () => {
            describe.skip("carol takeover the position", () => {
                it("swap carol's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
                it("close alice's position")
                it("force error, carol's quote balance is insufficient")
            })

            describe("carol send order to pool", () => {
                it.only("force close alice's base to quote by carol", async () => {
                    console.log((await clearingHouse.buyingPower(alice.address)).toString())
                    console.log((await vault.getFreeCollateral(alice.address)).toString())
                    console.log((await clearingHouse.getTotalMarketPnl(alice.address)).toString())
                    console.log((await clearingHouse.getAccountValue(alice.address)).toString())
                    console.log((await clearingHouse.getPositionValue(alice.address, baseToken.address, 0)).toString())
                })
                it("transfer liquidationDiscount (liquidatedNotional * liquidationDiscount) to carol after swap", async () => {})
            })

            it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")
        })

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself", async () => {})
    })

    // TODO copy the sheet above and make another scenario for short
    describe("alice took short in ETH, bob took long", () => {
        describe("carol liquidate alice's position", () => {
            describe.skip("carol takeover the position", () => {
                it("swap carol's base to alice's quote in a discount (size * marketTWAP * liquidationDiscount)")
                it("close alice's position")
                it("force error, carol's base balance is insufficient")
            })

            describe("carol send order to pool", () => {
                it(
                    "force mint alice's quote to buy base (the cost will be liquidationNotional) and repay base-debt by carol",
                )
                it("transfer liquidationDiscount (liquidatedNotional * liquidationDiscount) to carol before swap")
            })

            it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund before swap")
        })

        describe("price goes up further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself")
    })

    describe("alice took long in ETH and BTC, price go down", () => {
        it("liquidate alice's ETH by carol")
        it("liquidate alice's BTC by carol")
    })

    describe("alice took short in ETH and BTC, price go down", () => {
        it("liquidate alice's ETH by carol")
        it("liquidate alice's BTC by carol")
    })
})
