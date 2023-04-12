import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { AccountBalance, BaseToken, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse.swap", () => {
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
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "10"
        const { maxTick, minTick } = await initMarket(fixture, initPrice)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick

        // prepare maker alice
        await collateral.mint(alice.address, parseUnits("1000", collateralDecimals))
        await deposit(alice, vault, 1000, collateral)
        await clearingHouse.connect(alice).addLiquidity({
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
    })

    // https://docs.google.com/spreadsheets/d/1fqUUUOofl2ovpW1Du5expYPc_aDI43lyGw50_55oE7k/edit#gid=879273398
    describe("increase short position (B2Q)", () => {
        let bobQuoteBalanceBefore
        let initOpenNotional
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)
            ;[, bobQuoteBalanceBefore] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            await clearingHouse.connect(bob).swap({
                // sell 1 base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
            })
            initOpenNotional = await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            const [, bobQuoteBalanceAfter] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            const bobQuoteSpent = bobQuoteBalanceAfter.sub(bobQuoteBalanceBefore)
            expect(initOpenNotional).to.deep.eq(bobQuoteSpent)
        })

        it("base balance--", async () => {
            const [bobBaseBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(bobBaseBalance).to.deep.eq(parseEther("-1"))
        })

        it("quote balance++", async () => {
            const [, bobQuoteBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(bobQuoteBalance.gt(0)).to.be.true
        })

        it("realizedPnl remains", async () => {
            const [pnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 25% position (exactInput), profit", () => {
            beforeEach(async () => {
                // mock index price to do short
                await mockIndexPrice(mockedPriceFeedDispatcher, "8")

                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("100", collateralDecimals))
                await deposit(carol, vault, 100, collateral)
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                })
                // market price: 8.116224332440548657

                // bob reduce 25% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: false, // quote to base
                    isExactInput: false, // is exact output (base)
                    amount: parseEther("0.25"),
                    sqrtPriceLimitX96: 0,
                })
                //market price: 8.152907785517378433
            })

            it("openNotionalAbs--", async () => {
                const openNotional = await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            it("realizedPnl++", async () => {
                const [pnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(pnl.gt(0)).be.true
            })
        })

        describe("reduce 25% position, loss", () => {
            it("openNotional--")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), profit", () => {
            it("clear openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("reduce 100% position (close), loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, only fee loss", () => {
            it("reverse open notional 's signed", async () => {})
            it("realizedPnl only includes fee", async () => {})
        })

        describe("swap reverse and larger amount, profit", () => {
            it("openNotional")
            it("realizedPnl++")
            it("settle realizePnl to collateral (decreased)")
        })

        describe("swap reverse and larger amount, loss", () => {
            it("clear openNotional")
            it("realizedPnl--")
            it("settle realizePnl to collateral (decreased)")
        })
    })

    describe("increase long position (Q2B)", () => {
        let initOpenNotional
        let posSizeBefore
        beforeEach(async () => {
            await collateral.mint(bob.address, parseUnits("25", collateralDecimals))
            await deposit(bob, vault, 25, collateral)

            // mock index price to do long
            await mockIndexPrice(mockedPriceFeedDispatcher, "20")
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true, // exact quote
                amount: parseEther("250"),
                sqrtPriceLimitX96: 0,
            })
            // market price: 15.5625625

            initOpenNotional = await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)
            posSizeBefore = await accountBalance.getTotalPositionSize(bob.address, baseToken.address)
        })

        it("openNotional++", async () => {
            expect(initOpenNotional).to.deep.eq(parseEther("-250"))
        })

        it("base balance++", async () => {
            const [baseBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(baseBalance).be.gt(0)
        })

        it("quote balance--", async () => {
            const [, quoteBalance] = await clearingHouse.getTokenBalance(bob.address, baseToken.address)
            expect(quoteBalance).to.deep.eq(parseEther("-250"))
        })

        it("realizedPnl remains", async () => {
            const [pnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(pnl).eq(0)
        })

        describe("reduce 75% position (exactOutput), loss", () => {
            beforeEach(async () => {
                // mock index price to do short
                await mockIndexPrice(mockedPriceFeedDispatcher, "10")

                // another trader carol sell base, price down
                await collateral.mint(carol.address, parseUnits("10000", collateralDecimals))
                await deposit(carol, vault, 10000, collateral)
                await clearingHouse.connect(carol).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false, // exact output (quote)
                    amount: parseEther("50"),
                    sqrtPriceLimitX96: 0,
                })

                const bobPosSize = await accountBalance.getTotalPositionSize(bob.address, baseToken.address)
                const partial = bobPosSize.div(4).mul(3)
                // bob reduce 75% position
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true, // is exact input (base)
                    amount: partial,
                    sqrtPriceLimitX96: 0,
                })
            })

            it("openNotional--", async () => {
                const openNotional = await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)
                // expect openNotion are same signed
                expect(openNotional.mul(initOpenNotional).gt(0))
                expect(openNotional.abs().lt(initOpenNotional.abs())).be.true
            })

            // problem: it might increase the realized pnl when reducing position
            it("realizedPnl--", async () => {
                const [pnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(pnl.lt(0)).be.true
            })
        })

        describe("swap reverse and larger amount, only fee loss", () => {
            beforeEach(async () => {
                // mock index price to do short
                await mockIndexPrice(mockedPriceFeedDispatcher, "5")

                // bob opens a larger reverse position (short)
                await collateral.mint(bob.address, parseUnits("1000", collateralDecimals))
                await deposit(bob, vault, 1000, collateral)
                await clearingHouse.connect(bob).swap({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false, // is exact output (quote)
                    amount: parseEther("400"),
                    sqrtPriceLimitX96: 0,
                })
                // market price: 7.114240900163248648
            })

            it("realizedPnl is negative", async () => {
                // 1st 250 USD -> 19.839679358717434869 ETH
                // 2nd 38.3990039298 ETH -> 400 USD
                // closedNotional = 400/(38.3990039298/19.839679358717434869) = 206.6686875002
                // pnl = 206.6686875002 - 250 = -43.3313124998
                const [pnl] = await accountBalance.getPnlAndPendingFee(bob.address)
                expect(pnl).eq(parseEther("-43.331312499999999962"))
            })

            it("reverse open notional 's signed", async () => {
                // 400 - 206.6686875002 = 193.3313124998
                const openNotional = await accountBalance.getTotalOpenNotional(bob.address, baseToken.address)
                expect(openNotional).eq(parseEther("193.331312499999999962"))
            })
        })
    })
})
