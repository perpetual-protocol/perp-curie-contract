import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    InsuranceFund,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, b2qExactOutput, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { mockIndexPrice, mockMarkPrice, syncIndexToMarketPrice, syncMarkPriceToMarketPrice } from "../shared/utilities"

describe("Vault test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let vault: Vault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let mockedWethPriceFeed: MockContract
    let mockedWbtcPriceFeed: MockContract
    let clearingHouse: TestClearingHouse
    let insuranceFund: InsuranceFund
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        mockedWethPriceFeed = fixture.mockedWethPriceFeed
        mockedWbtcPriceFeed = fixture.mockedWbtcPriceFeed
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        insuranceFund = fixture.insuranceFund
        accountBalance = fixture.accountBalance as TestAccountBalance
        exchange = fixture.exchange as TestExchange
        pool = fixture.pool
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        usdcDecimals = await usdc.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice)
        await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // set a higher price limit for large orders
        await exchange.setMaxTickCrossedWithinBlock(baseToken.address, "100000")

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("3000", 8))
        mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("40000", 8))

        await weth.mint(alice.address, parseEther("10"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseUnits("5", await wbtc.decimals()))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await usdc.mint(bob.address, parseUnits("1000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await addOrder(fixture, bob, 500, 1000000, 0, 150000)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    describe("# getBalanceByToken", () => {
        it("returns correct collateral token balance", async () => {
            await deposit(alice, vault, 10, weth)
            await deposit(alice, vault, 3, wbtc)

            // balance of alice
            expect(await vault.getBalanceByToken(alice.address, weth.address)).to.eq(parseEther("10"))
            expect(await vault.getBalanceByToken(alice.address, wbtc.address)).to.eq(
                parseUnits("3", await wbtc.decimals()),
            )
            expect(await vault.getBalanceByToken(alice.address, usdc.address)).to.eq("0")

            // balance of bob
            expect(await vault.getBalanceByToken(bob.address, usdc.address)).to.eq(parseUnits("1000000", usdcDecimals))
        })

        it("returns correct settlement token balance without fee, funding payment, realized/unrealized PnL", async () => {
            await deposit(alice, vault, 1000, usdc)

            await weth.mint(bob.address, parseEther("10"))
            await weth.connect(bob).approve(vault.address, ethers.constants.MaxUint256)
            await deposit(bob, vault, 10, weth)

            // simulate fee & unrealized PnL
            await q2bExactInput(fixture, alice, 100, baseToken.address)
            // simulate funding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "200")
            await mockMarkPrice(accountBalance, baseToken.address, "200")
            await forwardBothTimestamps(clearingHouse, 360)

            expect(await vault.getBalanceByToken(alice.address, usdc.address)).to.be.eq(
                parseUnits("1000", usdcDecimals),
            )
            expect(await vault.getBalanceByToken(bob.address, weth.address)).to.be.eq(parseEther("10"))
        })
    })

    describe("# getCollateralTokens", () => {
        it("returns correct collateral tokens when having collaterals", async () => {
            await deposit(alice, vault, 1, weth)
            await deposit(alice, vault, 1, wbtc)

            expect(await vault.getCollateralTokens(alice.address)).to.deep.eq([weth.address, wbtc.address])
        })
    })

    describe("withdraw non-settlement token", () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            amount = parseEther("10")
            await deposit(alice, vault, 10, weth)
        })

        it("emit event and update balances", async () => {
            const aliceBalanceBefore = await weth.balanceOf(alice.address)
            const vaultBalanceBefore = await weth.balanceOf(vault.address)
            await expect(vault.connect(alice).withdraw(weth.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(weth.address, alice.address, amount)

            // decrease vault's token balance
            const vaultBalanceAfter = await weth.balanceOf(vault.address)
            expect(vaultBalanceBefore.sub(vaultBalanceAfter)).to.eq(amount)

            // sender's token balance increased
            const aliceBalanceAfter = await weth.balanceOf(alice.address)
            expect(aliceBalanceAfter.sub(aliceBalanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalanceByToken(alice.address, weth.address)).to.eq("0")
        })

        it("force error, not enough freeCollateral", async () => {
            // alice open a position so free collateral is not enough
            await q2bExactInput(fixture, alice, 50, baseToken.address)
            await expect(vault.connect(alice).withdraw(weth.address, amount)).to.be.revertedWith("V_NEFC")
        })

        it("withdrawable weth amount is reducing after trader open position", async () => {
            await q2bExactInput(fixture, alice, 1000, baseToken.address)

            // (weth * wethPrice * collateralRatio - usdcSpent * imRatio) / wethPrice / collateralRatio
            // free collateral of weth: (10 * 3000 * 0.7 - 1000 * 10%) / 3000 / 0.7 = 9.95238095
            const wethFreeCollateral = await vault.getFreeCollateralByToken(alice.address, weth.address)
            await expect(vault.connect(alice).withdraw(weth.address, wethFreeCollateral))
                .to.emit(vault, "Withdrawn")
                .withArgs(weth.address, alice.address, wethFreeCollateral)

            expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq("0")
            expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq(amount.sub(wethFreeCollateral))
        })

        it("with positive realized PnL", async () => {
            // alice open a long position
            await q2bExactInput(fixture, alice, 1000, baseToken.address)
            // bob long so alice has negative realized PnL after closing position
            await q2bExactInput(fixture, bob, 2000, baseToken.address)
            await closePosition(fixture, alice)

            await expect(vault.connect(alice).withdraw(weth.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(weth.address, alice.address, amount)
            // can withdraw up to the amount originally deposited
            expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq("0")
            expect(await vault.getBalanceByToken(alice.address, weth.address)).to.be.eq("0")
        })
    })

    describe("withdraw settlement token", () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            amount = parseUnits("100", usdcDecimals)
            await deposit(alice, vault, 100, usdc)
        })

        it("emit event and update balances", async () => {
            const aliceBalanceBefore = await usdc.balanceOf(alice.address)
            const vaultBalanceBefore = await usdc.balanceOf(vault.address)

            await expect(vault.connect(alice).withdraw(usdc.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, amount)

            // decrease vault's token balance
            const vaultBalanceAfter = await usdc.balanceOf(vault.address)
            expect(vaultBalanceBefore.sub(vaultBalanceAfter)).to.eq(amount)

            // sender's token balance increased
            const aliceBalanceAfter = await usdc.balanceOf(alice.address)
            expect(aliceBalanceAfter.sub(aliceBalanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.eq("0")
        })

        it("force error, not enough freeCollateral", async () => {
            // alice open a position so free collateral is not enough
            await q2bExactInput(fixture, alice, 50, baseToken.address)
            await expect(vault.connect(alice).withdraw(usdc.address, amount)).to.be.revertedWith("V_NEFC")
        })

        it("with positive realized PnL", async () => {
            // alice open a long position
            await q2bExactInput(fixture, alice, 300, baseToken.address)
            // bob long so alice has positive realized PnL after closing position
            await q2bExactInput(fixture, bob, 2000, baseToken.address)
            // realized PnL after closing:9.41576439
            await closePosition(fixture, alice)

            await expect(vault.connect(alice).withdraw(usdc.address, parseUnits("5", usdcDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, parseUnits("5", usdcDecimals))

            // balance after withdrawal: 100 - 5 + 9.415764 = 104.415764
            expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("104.415764", usdcDecimals))
            const realizedPnLAfterWithdrawal = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            // realized PnL is settled after withdrawal
            expect(realizedPnLAfterWithdrawal).to.be.eq("0")
        })

        it("with negative realized PnL", async () => {
            // alice open a long position
            await q2bExactInput(fixture, alice, 300, baseToken.address)
            // bob long so alice has negative realized PnL after closing position
            await b2qExactOutput(fixture, bob, 2000, baseToken.address)
            // realized PnL: -21.26531049
            await closePosition(fixture, alice)

            await expect(vault.connect(alice).withdraw(usdc.address, parseUnits("30", usdcDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, parseUnits("30", usdcDecimals))

            // balance after withdrawal: 100 - 30 - 21.26531 = 48.73469
            expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("48.734689", usdcDecimals))
            const realizedPnLAfterWithdrawal = (await accountBalance.getPnlAndPendingFee(alice.address))[0]
            // realized PnL is settled after withdrawal
            expect(realizedPnLAfterWithdrawal).to.be.eq("0")
        })

        it("settle funding when withdrawing", async () => {
            // alice open a long position
            await q2bExactInput(fixture, alice, 300, baseToken.address)
            // alice will get funding since index price > market price
            await mockIndexPrice(mockedPriceFeedDispatcher, "200")
            await mockMarkPrice(accountBalance, baseToken.address, "200")
            await forwardBothTimestamps(clearingHouse, 360)
            // pending funding payment: -0.16422554

            await expect(vault.connect(alice).withdraw(usdc.address, parseUnits("10", usdcDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, parseUnits("10", usdcDecimals))

            // owedRealizedPnl (realized funding payment): -0.162868
            // check getBalance = 100 - 10 - (-0.162868) = 90.162868
            expect(await vault.getBalance(alice.address)).to.be.eq(parseUnits("90.162868", usdcDecimals))
            expect(await exchange.getPendingFundingPayment(alice.address, baseToken.address)).to.be.eq("0")
            expect((await accountBalance.getPnlAndPendingFee(alice.address))[2]).to.be.eq("0")
        })
    })

    describe("# getSettlementTokenValue", () => {
        describe("trader has usdc balance", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 1000, usdc)
                await deposit(alice, vault, 10, weth)
                // position size: 18.88437579
                await q2bExactInput(fixture, alice, 3000, baseToken.address)
            })

            it("trader has negative unrealized pnl and usdc debt", async () => {
                // mock mark price to make trader has loss
                await mockMarkPrice(accountBalance, baseToken.address, "100")

                // mock index price to calculate funding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "100")

                await forwardBothTimestamps(clearingHouse, 360)
                // unrealized PnL: 100 * 18.88437579 - 3000 = -1111.562421
                // funding payment: 0.786847
                // settlement token value: 1000 - 0.786847 - 1111.562421 = -112.349268
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-112.349270", usdcDecimals),
                )
            })

            it("trader has negative unrealized pnl and doesn't have usdc debt", async () => {
                // mock mark price to make trader has loss
                await mockMarkPrice(accountBalance, baseToken.address, "150")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "150")

                await forwardBothTimestamps(clearingHouse, 360)
                // unrealized PnL: 150 * 18.88437579 - 3000 = -167.3436315
                // funding payment: 1.0395235
                // settlement token value: 1000 - 1.0395235 - 167.3436315 = 831.616845
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("831.616844", usdcDecimals),
                )
            })

            it("trader has positive unrealized pnl", async () => {
                // mock mark price to make trader has profit
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "180")

                await forwardBothTimestamps(clearingHouse, 360)
                // unrealized PnL: 180 * 18.88437579 - 3000 = 399.1876422
                // funding payment: -1.3210218
                // settlement token value: 1000 - (-1.3210218) + 399.1876422 = 1400.508664
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("1400.508664", usdcDecimals),
                )
            })

            it("trader is both maker & taker", async () => {
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

                await addOrder(fixture, alice, 10, 2000, 0, 150000)
                // bob swap, alice get maker fee
                await q2bExactInput(fixture, bob, 3000, baseToken.address)
                // market price: 175.63239005

                // mock mark price to make trader has profit
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "180")

                await forwardBothTimestamps(clearingHouse, 360)

                // total position size: 18.52739798
                // total quote balance in order: 60.47455739
                // total open notional: -3000 + 60.47455739 = -2939.52544261
                // unrealized PnL: 18.52739798 * 180 - 2939.52544261 = 395.40619379
                // pending maker fee: 0.549769
                // pending funding payment: -0.371717
                // settlement token value: 1000 + 0.549769 - (-0.371717) + 395.40619379 = 1396.327679
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.closeTo(
                    parseUnits("1396.327679", usdcDecimals),
                    // there can be a little imprecision due to pending funding payment and decimal conversion
                    parseUnits("0.01", usdcDecimals).toNumber(),
                )
            })

            it("trader has positive realized PnL", async () => {
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

                // bob long, so alice can have positive realized PnL after closing position
                await q2bExactInput(fixture, bob, 1000, baseToken.address)

                // mock mark price to make trader has profit
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                await forwardBothTimestamps(clearingHouse, 360)

                await closePosition(fixture, alice)
                // realized PnL (including funding payment): 12.569457
                // settlement token value: 1000 + 12.569457 = 1012.569457
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.closeTo(
                    parseUnits("1012.569457", usdcDecimals),
                    // there can be a little imprecision due to pending funding payment and decimal conversion
                    parseUnits("0.01", usdcDecimals).toNumber(),
                )
            })

            it("trader has negative realized PnL", async () => {
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

                // bob short, so alice can have negative realized PnL after closing position
                await b2qExactOutput(fixture, bob, 1000, baseToken.address)

                // mock mark price to make trader has loss
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                await forwardBothTimestamps(clearingHouse, 360)

                await closePosition(fixture, alice)

                // realized PnL (including funding payment): -132.53927
                // settlement token value: 1000 - 132.53927 = 867.460730
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.closeTo(
                    parseUnits("867.460730", usdcDecimals),
                    parseUnits("0.01", usdcDecimals).toNumber(),
                )
            })
        })

        describe("trader doesn't have usdc balance", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 10, weth)
                // position size: 18.88437579
                await q2bExactInput(fixture, alice, 3000, baseToken.address)
            })

            it("trader has negative unrealized pnl and usdc debt", async () => {
                // mock mark price to make trader has loss
                await mockMarkPrice(accountBalance, baseToken.address, "100")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "100")

                await forwardBothTimestamps(clearingHouse, 360)
                // unrealized PnL: 100 * 18.88437579 - 3000 = -1111.562421
                // funding payment: -0.786847
                // settlement token value: -0.786847 - 1111.562421 = -1112.349268
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("-1112.349270", usdcDecimals),
                )
            })

            it("trader has positive unrealized pnl", async () => {
                // mock mark price to make trader has profit
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "180")

                await forwardBothTimestamps(clearingHouse, 360)
                // unrealized PnL: 180 * 18.88437579 - 3000 = 399.1876422
                // funding payment: -1.3158838
                // settlement token value: 1.3158838 + 399.1876422 = 400.503526
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.eq(
                    parseUnits("400.503527", usdcDecimals),
                )
            })

            it("trader is both maker & taker", async () => {
                await addOrder(fixture, alice, 10, 2000, 0, 150000)
                // bob swap, alice get maker fee
                await q2bExactInput(fixture, bob, 300, baseToken.address)

                // mock mark price to make trader has profit
                await mockMarkPrice(accountBalance, baseToken.address, "180")

                // mock index price to calculate founding payment
                await mockIndexPrice(mockedPriceFeedDispatcher, "180")

                await forwardBothTimestamps(clearingHouse, 360)

                // total position size: 18.84750169711406076
                // total open notional: -2993.952544261279477388
                // unrealized PnL: 18.84750169711406076 * 180 -2993.952544261279477388 = 398.5977612193
                // pending maker fee: 0.054976870352004751
                // pending funding payment: -1.219374926076949977
                // settlement token value: 0.054976870352004751 - (-1.219374926076949977) + 398.5977612193 = 399.872113
                expect(await vault.getSettlementTokenValue(alice.address)).to.be.closeTo(
                    parseUnits("399.872113", usdcDecimals),
                    // there can be a little imprecision due to pending funding payment and decimal conversion
                    parseUnits("0.01", usdcDecimals).toNumber(),
                )
            })
        })
    })

    describe("# getAccountValue", () => {
        beforeEach(async () => {
            await deposit(alice, vault, 500, usdc)
            await deposit(alice, vault, 0.1, weth)
            await deposit(alice, vault, 0.01, wbtc)
            // position size: 18.88437579
            await q2bExactInput(fixture, alice, 3000, baseToken.address)
        })

        it("trader has negative unrealized pnl", async () => {
            // mock mark price to make trader has loss
            await mockMarkPrice(accountBalance, baseToken.address, "100")

            // mock index price to calculate founding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "100")

            await forwardBothTimestamps(clearingHouse, 360)

            // unrealized PnL: 100 * 18.884375790674023929 - 3000 = -1111.5624209326
            // funding payment: 0.78684899127808433
            // account value: 500 + 0.1 * 3000 * 0.7 + 0.01 * 40000 * 0.7 - 0.78684899127808433 - 1111.5624209326 = -122.349267
            expect(await vault.getAccountValue(alice.address)).to.be.closeTo(
                parseUnits("-122.349267", usdcDecimals),
                // there can be a little imprecision due to pending funding payment and decimal conversion
                parseUnits("0.01", usdcDecimals).toNumber(),
            )
        })

        it("trader has positive unrealized pnl", async () => {
            // mock mark price to make trader has profit
            await mockMarkPrice(accountBalance, baseToken.address, "180")

            // mock index price to calculate founding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "180")

            await forwardBothTimestamps(clearingHouse, 360)
            // unrealized PnL: 180 * 18.88437579 - 3000 = 399.1876422
            // funding payment: -1.326158286620314967
            // account value: 500 + 0.1 * 3000 * 0.7 + 0.01 * 40000 * 0.7 - (-1.326158286620314967) + 399.1876422 = 1390.513800
            expect(await vault.getAccountValue(alice.address)).to.be.closeTo(
                parseUnits("1390.513800", usdcDecimals),
                // there can be a little imprecision due to pending funding payment and decimal conversion
                parseUnits("0.01", usdcDecimals).toNumber(),
            )
        })

        it("trader is both maker & taker", async () => {
            await addOrder(fixture, alice, 10, 2000, 0, 150000)
            // bob swap, alice get maker fee
            await q2bExactInput(fixture, bob, 300, baseToken.address)

            // market price: 164.605506117068038532

            // mock mark price to make trader has profit
            await mockMarkPrice(accountBalance, baseToken.address, "180")

            // mock index price to calculate funding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "180")

            await forwardBothTimestamps(clearingHouse, 360)

            // total position size: 18.84750169711406076
            // total open notional: -2993.952544261279477388
            // unrealized PnL: 18.84750169711406076 * 180 - 2993.952544261279477388 = 398.5977612193
            // pending maker fee: 0.054976870352004751
            // pending funding payment: -1.230993742106468956
            // account value: (500 + 0.1 * 3000 * 0.7 + 0.01 * 40000 * 0.7) + 0.054976870352004751 - (-1.219374926076949977) + 398.5977612193 = 1389.872113
            expect(await vault.getAccountValue(alice.address)).to.be.closeTo(
                parseUnits("1389.872113", usdcDecimals),
                // there can be a little imprecision due to pending funding payment and decimal conversion
                parseUnits("0.1", usdcDecimals).toNumber(),
            )
        })

        it("trader has positive realized PnL", async () => {
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            // bob long, so alice can have positive realized PnL after closing position
            await q2bExactInput(fixture, bob, 1000, baseToken.address)

            // mock mark price to make trader has profit
            await mockMarkPrice(accountBalance, baseToken.address, "170")

            // mock index price to calculate founding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "170")

            await forwardBothTimestamps(clearingHouse, 360)

            await closePosition(fixture, alice)

            // realized PnL(including funding): 13.096488
            // account value: 500 + 0.1 * 3000 * 0.7 + 0.01 * 40000 * 0.7 + 13.096488 = 1003.096488
            expect(await vault.getAccountValue(alice.address)).to.be.closeTo(
                parseUnits("1003.096488", usdcDecimals),
                // there can be a little imprecision due to pending funding payment and decimal conversion
                parseUnits("0.01", usdcDecimals).toNumber(),
            )
        })

        it("trader has negative realized PnL", async () => {
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            // bob short, so alice can have negative realized PnL after closing position
            await b2qExactOutput(fixture, bob, 1000, baseToken.address)

            // mock mark price to make trader has lose
            await mockMarkPrice(accountBalance, baseToken.address, "160")

            // mock index price to calculate founding payment
            await mockIndexPrice(mockedPriceFeedDispatcher, "160")

            await forwardBothTimestamps(clearingHouse, 360)

            await closePosition(fixture, alice)

            // realized PnL(including funding): -132.803228
            // account value: 500 + 0.1 * 3000 * 0.7 + 0.01 * 40000 * 0.7 - 132.803228 = 857.196772
            expect(await vault.getAccountValue(alice.address)).to.be.closeTo(
                parseUnits("857.196772", usdcDecimals),
                // there can be a little imprecision due to pending funding payment and decimal conversion
                parseUnits("0.01", usdcDecimals).toNumber(),
            )
        })
    })
})
