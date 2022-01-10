import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { ethers } from "ethers"
import { parseUnits } from "ethers/lib/utils"
import { waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    TestAccountBalance,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault withdraw test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let clearingHouse: ClearingHouse
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance | TestAccountBalance
    let exchange: Exchange
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    const check = async (user: ethers.Wallet, hasAccountValue: boolean) => {
        let freeCollateral
        let accountValue

        // check user
        freeCollateral = await vault.getFreeCollateral(user.address)
        await expect(vault.connect(user).withdraw(usdc.address, freeCollateral))
            .to.emit(vault, "Withdrawn")
            .withArgs(usdc.address, user.address, freeCollateral)

        freeCollateral = await vault.getFreeCollateral(user.address)
        accountValue = await clearingHouse.getAccountValue(user.address)
        expect(freeCollateral).to.be.eq(0)
        if (!hasAccountValue) {
            expect(accountValue).to.be.eq(0)
        }
        await expect(vault.connect(user).withdraw(usdc.address, 1)).to.be.revertedWith("V_NEFC")
    }

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(true))
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

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151.373306", 6), 0, 0, 0]
        })

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(await pool.tickSpacing()),
        )

        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // alice mint and
        await usdc.mint(alice.address, parseUnits("10000000", usdcDecimals))
        await deposit(alice, vault, 1000000, usdc)

        // bob mint and add liquidity
        await usdc.mint(bob.address, parseUnits("1000", usdcDecimals))
        await deposit(bob, vault, 1000, usdc)
        await addOrder(fixture, bob, 10, 1500, 0, 150000)
    })

    describe("withdraw check", async () => {
        beforeEach(async () => {
            // alice swap
            await q2bExactInput(fixture, alice, 100)
        })

        it("withdraw full freeCollateral after remove liquidity and position", async () => {
            // alice close position
            await closePosition(fixture, alice)

            // bob remove liquidity & close position
            await removeAllOrders(fixture, bob)

            await check(bob, false)
            await check(alice, false)
        })

        it("withdraw full freeCollateral when user has position", async () => {
            await check(bob, true)
            await check(alice, true)
        })

        it("withdraw full freeCollateral when user has no position", async () => {
            await closePosition(fixture, alice)

            await check(bob, true) // still provide liquidity
            await check(alice, false)
        })

        it("withdraw full freeCollateral when user has position but no liquidity", async () => {
            // bob remove liquidity & close position
            await removeAllOrders(fixture, bob)

            await check(bob, true)
            await check(alice, true)
        })

        it("won't collect fee before withdraw when maker make profit", async () => {
            // alice swap, bob has pending fee
            await q2bExactInput(fixture, alice, 100)
            await closePosition(fixture, alice)

            let pendingFee = (await accountBalance.getPnlAndPendingFee(bob.address))[2]
            expect(pendingFee).to.be.gt(0)

            // maker withdraw
            const freeCollateral = await vault.getFreeCollateral(bob.address)
            await vault.connect(bob).withdraw(usdc.address, freeCollateral)

            // pending fee remains the same
            const pendingFeeAfter = (await accountBalance.getPnlAndPendingFee(bob.address))[2]
            expect(pendingFee).to.be.deep.eq(pendingFeeAfter)
        })
    })
})
