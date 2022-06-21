import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt, syncIndexToMarketPrice } from "../shared/utilities"

describe("Exchange complicated test", () => {
    const [admin, maker, taker] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let clearingHouse: ClearingHouse
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance
    let exchange: Exchange
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        clearingHouse = fixture.clearingHouse
        insuranceFund = fixture.insuranceFund
        accountBalance = fixture.accountBalance
        exchange = fixture.exchange
        pool = fixture.pool
        baseToken = fixture.baseToken
        marketRegistry = fixture.marketRegistry
        mockedBaseAggregator = fixture.mockedBaseAggregator

        usdcDecimals = await usdc.decimals()

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )
        await syncIndexToMarketPrice(mockedBaseAggregator, pool)

        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // taker mint
        await usdc.mint(taker.address, parseUnits("10000000", usdcDecimals))
        await deposit(taker, vault, 1000000, usdc)

        // maker mint
        await usdc.mint(maker.address, parseUnits("10000000", usdcDecimals))
        await deposit(maker, vault, 1000000, usdc)
    })

    describe("exchange should fail in the following scenarios", async () => {
        it("no liquidity", async () => {
            // maker add liquidity
            await addOrder(fixture, maker, 200, 100000, 0, 150000)

            // taker open position
            await q2bExactInput(fixture, taker, 100)

            // maker remove all liquidity
            await removeAllOrders(fixture, maker)

            // taker close position should be revert
            await expect(closePosition(fixture, taker)).to.be.revertedWith("CH_F0S")

            // maker close position should be revert
            await expect(closePosition(fixture, maker)).to.be.revertedWith("CH_F0S")
        })
    })
})
