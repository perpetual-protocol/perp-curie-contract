import { waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { toWei } from "../helper/number"
import { deposit } from "../helper/token"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const million = toWei(1000000)
    const thousand = toWei(1000)
    const ten = toWei(10)
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let pool: UniswapV3Pool
    let baseToken2: TestERC20
    let pool2: UniswapV3Pool

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

        // add pool
        await clearingHouse.addPool(baseToken.address, 10000)
        await clearingHouse.addPool(baseToken2.address, 10000)

        // mint
        collateral.mint(alice.address, million)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)

        await deposit(alice, vault, 1000000, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        // mint quote
        await clearingHouse.connect(alice).mint(quoteToken.address, thousand)
        await clearingHouse.connect(bob).mint(quoteToken.address, thousand)
        await clearingHouse.connect(carol).mint(quoteToken.address, thousand)

        // mint base
        await clearingHouse.connect(alice).mint(baseToken.address, ten)
        await clearingHouse.connect(bob).mint(baseToken.address, ten)
        await clearingHouse.connect(carol).mint(baseToken.address, ten)
    })

    describe("adjustable parameter", () => {
        it("setLiquidationDiscount")
        it("setLiquidationPenaltyRatio")
        it("force error, only admin")
    })

    describe("alice took long in ETH, price doesn't change", () => {
        it("force error, margin ratio is above the requirement")
    })

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    // Two takers; has PnL
    describe("alice took long in ETH, bob took short", () => {
        describe("carol liquidate alice's position", () => {
            describe.skip("carol takeover the position", () => {
                it("swap carol's quote to alice's base in a discount (size * marketTWAP * liquidationDiscount)")
                it("close alice's position")
                it("force error, carol's quote balance is insufficient")
            })

            describe("carol send order to pool", () => {
                it("force close alice's base to quote by carol")
                it("transfer liquidationDiscount (liquidatedNotional * liquidationDiscount) to carol after swap")
            })

            it.skip("transfer penalty (liquidationNotional * liquidationPenaltyRatio) to InsuranceFund after swap")
        })

        describe("price goes down further, alice's price impact is too high if total close", () => {
            it.skip("liquidate alice's position partially by carol")
        })

        it("force error, can't liquidate herself")
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
