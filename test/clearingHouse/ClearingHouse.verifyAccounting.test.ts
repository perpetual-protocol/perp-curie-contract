import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, BigNumberish, Wallet } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { InsuranceFund, UniswapV3Pool, Vault } from "../../typechain"
import {
    addOrder,
    b2qExactInput,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    q2bExactOutput,
    removeAllOrders,
    removeOrder,
} from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { mintAndDeposit } from "../helper/token"
import { mockIndexPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse verify accounting", () => {
    const wallets = waffle.provider.getWallets()
    const [admin, maker, alice, bob, carol] = wallets
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    const uniFeeRatio = 500 // 0.05%
    const exFeeRatio = 1000 // 0.1%
    const ifFeeRatio = 100000 // 10%
    const dustPosSize = 100
    let fixture: ClearingHouseFixture
    let vault: Vault
    let decimals: number
    let insuranceFund: InsuranceFund
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let lowerTick: number
    let upperTick: number
    let baseTokenList: string[]
    let balanceBefore: BigNumberish

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        vault = fixture.vault
        decimals = await fixture.USDC.decimals()
        insuranceFund = fixture.insuranceFund
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        // mint 1000 to every wallets and store balanceBefore
        for (const wallet of wallets) {
            await mintAndDeposit(fixture, wallet, 1000)
        }
        balanceBefore = parseUnits("1000", decimals).mul(wallets.length)

        const initPrice = "10"
        // prepare market
        const { minTick, maxTick } = await initMarket(fixture, initPrice, exFeeRatio, ifFeeRatio, undefined)
        await mockIndexPrice(mockedPriceFeedDispatcher, initPrice)

        lowerTick = minTick
        upperTick = maxTick
        await addOrder(fixture, maker, 100, 1000, lowerTick, upperTick)

        baseTokenList = [fixture.baseToken.address]
    })

    // verify accounting inside afterEach
    // similar to perp-backed repo's analyzer, remove all order and close position except 1 maker
    // settle the last maker by collect fee, close position and remove order.
    // (when everyone has 0 positionSize, their freeCollateral == actual USDC they can withdraw)
    // and the freeCollateral is a number that's already being calculated by realizedPnl
    // expect sum of everyone's freeCollateral == sum of everyone's deposit == usdc.balanceOf(vault)
    afterEach(async () => {
        let balanceAfter = BigNumber.from(0)

        async function updateAfterBalanceByFreeCollateralFrom(trader: string) {
            const freeCollateral = await fixture.vault.getFreeCollateral(trader)
            balanceAfter = balanceAfter.add(freeCollateral)
        }

        async function checkPosSizeEmpty(wallet: Wallet, baseToken: string) {
            expect(await fixture.accountBalance.getTotalPositionSize(wallet.address, baseToken)).be.closeTo(
                BigNumber.from(0),
                dustPosSize,
            )
        }

        // close every trader's position and orders. freeCollateral = collateral after all positions are settled
        const walletsWithoutMaker = wallets.filter(it => it.address !== maker.address)
        for (const baseToken of baseTokenList) {
            for (const wallet of walletsWithoutMaker) {
                await removeAllOrders(fixture, wallet, baseToken)
                await closePosition(fixture, wallet, dustPosSize, baseToken)
                await checkPosSizeEmpty(wallet, baseToken)
            }

            await removeAllOrders(fixture, maker, baseToken)
            await closePosition(fixture, maker, dustPosSize, baseToken)
            await checkPosSizeEmpty(maker, baseToken)
        }

        // sum every wallet's freeBalance to balanceAfter
        for (const wallet of wallets) {
            // make sure they are actually being settled
            expect(await fixture.accountBalance.getTotalDebtValue(wallet.address)).be.closeTo(
                BigNumber.from(0),
                dustPosSize,
            )
            await updateAfterBalanceByFreeCollateralFrom(wallet.address)
        }

        // calculate insuranceFund's income
        await updateAfterBalanceByFreeCollateralFrom(insuranceFund.address)

        // entire balance should be equal (might have some rounding error, let's assume 0.01)
        expect(balanceBefore).be.closeTo(balanceAfter, 10000)
    })

    describe("single market", async () => {
        await startTest()
    })

    describe("two markets", async () => {
        beforeEach(async () => {
            const initPrice = "10"
            await initMarket(fixture, initPrice, exFeeRatio, ifFeeRatio, undefined, fixture.baseToken2.address)
            await mockIndexPrice(fixture.mockedPriceFeedDispatcher2, initPrice)

            await addOrder(fixture, maker, 100, 1000, lowerTick, upperTick, false, fixture.baseToken2.address)
            baseTokenList.push(fixture.baseToken2.address)
        })

        await startTest()
    })

    async function startTest() {
        describe("one trade", () => {
            it("q2bExactOutput", async () => {
                await q2bExactOutput(fixture, alice, 1)
            })

            it("q2bExactInput", async () => {
                await q2bExactInput(fixture, alice, 10)
            })

            it("b2qExactOutput", async () => {
                await b2qExactOutput(fixture, alice, 10)
            })

            it("b2qExactInput", async () => {
                await b2qExactInput(fixture, alice, 1)
            })
        })

        it("takerTradeWithOnlyOneMaker", async () => {
            // alice
            await q2bExactOutput(fixture, alice, 1)

            // bob
            await b2qExactOutput(fixture, bob, 10)

            // carol
            await b2qExactInput(fixture, carol, 1)
        })

        it("takerAddLiquidityWhileHavingPosition", async () => {
            // alice take position
            await q2bExactInput(fixture, alice, 10)

            // bob take position, bob profit++
            await q2bExactInput(fixture, bob, 10)

            // alice
            await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
            await addOrder(fixture, alice, 1, 100, lowerTick, upperTick)
            await removeOrder(fixture, alice, 0, lowerTick, upperTick)
            await closePosition(fixture, alice)

            // bob
            await closePosition(fixture, bob)
        })

        it("makerOpenPosition", async () => {
            // alice
            await addOrder(fixture, alice, 1, 10, lowerTick, upperTick)
            await q2bExactInput(fixture, alice, 10)

            // bob take position, bob profit++
            await q2bExactInput(fixture, bob, 10)
        })
    }
})
