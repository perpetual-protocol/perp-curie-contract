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
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault withdraw test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
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
        fixture = await loadFixture(createClearingHouseFixture(false))
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

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)
        await marketRegistry.addPool(baseToken.address, 10000)
        await marketRegistry.setFeeRatio(baseToken.address, 10000)

        // alice mint and
        await usdc.mint(alice.address, parseUnits("10000000", usdcDecimals))
        await deposit(alice, vault, 1000000, usdc)

        // bob mint and add liquidity
        await usdc.mint(bob.address, parseUnits("10000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await addOrder(fixture, bob, 200, 100000, 0, 150000)
    })

    describe("withdraw check", async () => {
        let freeCollateral
        let accountValue
        beforeEach(async () => {
            // alice swap
            await q2bExactInput(fixture, alice, 100)
            await closePosition(fixture, alice)
        })

        it("withdraw full freeCollateral after remove liquidity and position", async () => {
            // bob remove liquidity & close position
            await removeAllOrders(fixture, bob)
            await closePosition(fixture, bob)

            // check bob
            freeCollateral = await vault.getFreeCollateral(bob.address)

            await expect(vault.connect(bob).withdraw(usdc.address, freeCollateral))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, bob.address, freeCollateral)

            freeCollateral = await vault.getFreeCollateral(bob.address)
            accountValue = await clearingHouse.getAccountValue(bob.address)

            expect(freeCollateral).to.be.eq(0)
            expect(accountValue).to.be.eq(0)

            // check decimal rounding error
            expect(vault.connect(bob).withdraw(usdc.address, 1)).to.be.revertedWith("V_NEFC")
        })

        it("withdraw full freeCollateral when bob has position", async () => {
            // check bob
            freeCollateral = await vault.getFreeCollateral(bob.address)

            await expect(vault.connect(bob).withdraw(usdc.address, freeCollateral))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, bob.address, freeCollateral)

            freeCollateral = await vault.getFreeCollateral(bob.address)
            accountValue = await clearingHouse.getAccountValue(bob.address)

            expect(freeCollateral).to.be.eq(0)

            // check decimal rounding error
            expect(vault.connect(bob).withdraw(usdc.address, 1)).to.be.revertedWith("V_NEFC")
        })
    })
})
