import { MockContract } from "@eth-optimism/smock"
import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { ContractTransaction } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import { BaseToken, TestAccountBalance, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { addOrder, findLiquidityChangedEvents, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse accounting (liquidity)", () => {
    const [admin, maker1, maker2] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number
    let fixture: ClearingHouseFixture

    const [m1r1LowerTick, m1r1UpperTick] = [43980, 48000] // maker1 liquidity range1
    const [m1r2LowerTick, m1r2UpperTick] = [40000, 50000] // maker1 liquidity range2
    // maker2 liquidity range1 (deliberately the same as maker1 range1)
    const [m2r1LowerTick, m2r1UpperTick] = [m1r1LowerTick, m1r1UpperTick]
    // maker2 liquidity range2 (deliberately same lower bound as maker1 range1)
    const [m2r2LowerTick, m2r2UpperTick] = [m1r1LowerTick, 47980]
    // maker2 liquidity range2 (deliberately same upper bound as maker1 range1)
    const [m2r3LowerTick, m2r3UpperTick] = [44000, m1r1UpperTick]

    beforeEach(async () => {
        const uniFeeRatio = 500 // 0.05%
        const exFeeRatio = 1000 // 0.1%
        const ifFeeRatio = 100000 // 10%

        fixture = await loadFixture(createClearingHouseFixture(undefined, uniFeeRatio))
        vault = fixture.vault
        accountBalance = fixture.accountBalance as TestAccountBalance
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "100"
        await initMarket(fixture, initPrice, exFeeRatio, ifFeeRatio, 250)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // prepare collateral for makers
        await collateral.mint(maker1.address, parseUnits("1000", collateralDecimals))
        await deposit(maker1, vault, 1000, collateral)
        await collateral.mint(maker2.address, parseUnits("1000", collateralDecimals))
        await deposit(maker2, vault, 1000, collateral)
    })

    it("liquidity accounting is correct under normal add/remove activity", async () => {
        let liquidityBalance = BigNumber.from(0)
        // add maker1 range1 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker1, 10, 1000, m1r1LowerTick, m1r1UpperTick)),
        )
        // add maker1 range2 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker1, 10, 1000, m1r2LowerTick, m1r2UpperTick)),
        )
        // add maker2 range1 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker2, 10, 1000, m2r1LowerTick, m2r1UpperTick)),
        )
        // add maker2 range2 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker2, 10, 1000, m2r2LowerTick, m2r2UpperTick)),
        )
        // add maker2 range3 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker2, 10, 1000, m2r3LowerTick, m2r3UpperTick)),
        )

        // remove all liquidity
        for (const tx of await removeAllOrders(fixture, maker1)) {
            liquidityBalance = liquidityBalance.add(await extractLiquidityDelta(tx))
        }
        for (const tx of await removeAllOrders(fixture, maker2)) {
            liquidityBalance = liquidityBalance.add(await extractLiquidityDelta(tx))
        }

        expect(liquidityBalance).to.be.deep.eq(0)
    })

    it("liquidity accounting is correct under cancelling excess orders", async () => {
        let liquidityBalance = BigNumber.from(0)
        // add maker1 range1 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker1, 10, 1000, m1r1LowerTick, m1r1UpperTick)),
        )
        // add maker1 range2 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker1, 10, 1000, m1r2LowerTick, m1r2UpperTick)),
        )

        // add maker2 range1 liquidity
        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(await addOrder(fixture, maker2, 10, 1000, m2r1LowerTick, m2r1UpperTick)),
        )

        // raise mark price a lot so the maker orders are under-collateralized
        await mockMarkPrice(accountBalance, baseToken.address, "10000")

        liquidityBalance = liquidityBalance.add(
            await extractLiquidityDelta(
                await fixture.clearingHouse.connect(admin).cancelAllExcessOrders(maker1.address, baseToken.address),
            ),
        )
        expect(await fixture.accountBalance.hasOrder(maker1.address)).to.be.false

        // remove all maker2 liquidity
        for (const tx of await removeAllOrders(fixture, maker2)) {
            liquidityBalance = liquidityBalance.add(await extractLiquidityDelta(tx))
        }

        expect(liquidityBalance).to.be.deep.eq(0)
    })

    async function extractLiquidityDelta(tx: ContractTransaction): Promise<BigNumber> {
        const receipt = await tx.wait()
        let liquidityBalance = BigNumber.from(0)
        findLiquidityChangedEvents(fixture, receipt).map(event => {
            liquidityBalance = liquidityBalance.add(event.args.liquidity)
        })
        return liquidityBalance
    }
})
