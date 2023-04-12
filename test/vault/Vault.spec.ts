import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, Vault } from "../../typechain"
import { mockedVaultFixture } from "./fixtures"

describe("Vault spec", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let collateralManager: MockContract

    beforeEach(async () => {
        const _fixture = await loadFixture(mockedVaultFixture)
        vault = _fixture.vault
        usdc = _fixture.USDC
        collateralManager = _fixture.mockedCollateralManager

        collateralManager.smocked.getMaxCollateralTokensPerAccount.will.return.with(100)

        // mint
        const amount = parseUnits("1000", await usdc.decimals())
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        await usdc.mint(admin.address, amount)
    })

    describe("# initialize", () => {
        it("force error, invalid insurance fund address", async () => {
            const vaultFactory = await ethers.getContractFactory("Vault")
            const vault = (await vaultFactory.deploy()) as Vault
            await expect(
                vault.initialize(alice.address, alice.address, alice.address, alice.address),
            ).to.be.revertedWith("function call to a non-contract account")
        })
    })

    describe("decimals", () => {
        it("equals to settlement token's decimal", async () => {
            expect(await vault.decimals()).to.be.eq(await usdc.decimals())
        })
    })

    describe("admin only setter functions", () => {
        it("setTrustedForwarder", async () => {
            await expect(vault.setTrustedForwarder(usdc.address))
                .to.emit(vault, "TrustedForwarderChanged")
                .withArgs(usdc.address)
            expect(await vault.getTrustedForwarder()).to.be.eq(usdc.address)
        })

        it("setClearingHouse", async () => {
            await expect(vault.setClearingHouse(usdc.address))
                .to.emit(vault, "ClearingHouseChanged")
                .withArgs(usdc.address)
            expect(await vault.getClearingHouse()).to.be.eq(usdc.address)
        })

        it("setCollateralManager", async () => {
            await expect(vault.setCollateralManager(usdc.address))
                .to.emit(vault, "CollateralManagerChanged")
                .withArgs(usdc.address)
            expect(await vault.getCollateralManager()).to.be.eq(usdc.address)
        })

        it("setWETH9", async () => {
            await expect(vault.setWETH9(usdc.address)).to.emit(vault, "WETH9Changed").withArgs(usdc.address)
            expect(await vault.getWETH9()).to.be.eq(usdc.address)
        })

        it("force error, only admin", async () => {
            await expect(vault.connect(alice).setTrustedForwarder(usdc.address)).to.be.revertedWith("SO_CNO")
            await expect(vault.connect(alice).setClearingHouse(usdc.address)).to.be.revertedWith("SO_CNO")
            await expect(vault.connect(alice).setCollateralManager(usdc.address)).to.be.revertedWith("SO_CNO")
            await expect(vault.connect(alice).setWETH9(usdc.address)).to.be.revertedWith("SO_CNO")
        })

        it("force error, not a contract address", async () => {
            await expect(vault.setTrustedForwarder(alice.address)).to.be.revertedWith("V_TFNC")
            await expect(vault.setClearingHouse(alice.address)).to.be.revertedWith("V_CHNC")
            await expect(vault.setCollateralManager(alice.address)).to.be.revertedWith("V_CMNC")
            await expect(vault.setWETH9(alice.address)).to.be.revertedWith("V_WNC")
        })
    })

    describe("only receive Ether directly from WETH9", async () => {
        it("force error, not from WETH9", async () => {
            await expect(bob.sendTransaction({ to: vault.address, value: 1 })).to.be.revertedWith("V_SNW")
        })
    })

    describe("getFreeCollateral", () => {
        it("equals to total collateral value + locked collateral value (0)")
        it("equals to total collateral value + locked collateral value ( > 0)")
        it("force error, clearingHouse not found")
    })

    // TODO not sure if this is needed
    describe("getBalance", () => {
        it("is zero by default", async () => {
            expect(await vault.getBalance(alice.address)).eq(0)
        })

        it("equals to USDC balance if it's the only collateral")
        it("equals multi collateral's USDC value")
    })
})
