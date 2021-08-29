import { ethers, waffle } from "hardhat"
import { TestSafeOwnable } from "../../typechain"
import { expect } from "chai"

describe("SafeOwnable spec", () => {
    const [admin, alice] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let ownable: TestSafeOwnable

    async function createSafeOwnableFixture(): Promise<TestSafeOwnable> {
        // deploy TestSafeOwnable
        const ownableFactory = await ethers.getContractFactory("TestSafeOwnable")
        const ownable = (await ownableFactory.deploy()) as TestSafeOwnable
        return ownable
    }

    beforeEach(async () => {
        ownable = await loadFixture(createSafeOwnableFixture)
    })

    it("transfer ownership", async () => {
        await ownable.setOwner(alice.address)
        await expect(ownable.connect(alice).updateOwner())
            .to.emit(ownable, "OwnershipTransferred")
            .withArgs(admin.address, alice.address)
    })

    it("transfer ownership and set owner to another", async () => {
        await ownable.setOwner(alice.address)
        await ownable.connect(alice).updateOwner()

        // only owner can set owner, now owner is alice.address
        await ownable.connect(alice).setOwner(admin.address)
        expect(await ownable.candidate()).eq(admin.address)
    })

    it("force error, caller not owner", async () => {
        await expect(ownable.connect(alice).setOwner(alice.address)).to.be.revertedWith("SO_CNO")
    })

    it("force error set owner same as original", async () => {
        await expect(ownable.setOwner(admin.address)).to.be.revertedWith("SO_SAO")
    })

    it("force error, update owner but caller is not the candidate", async () => {
        await ownable.setOwner(alice.address)
        await expect(ownable.connect(admin).updateOwner()).to.be.revertedWith("SO_CNC")
    })

    it("force error, candiate is 0", async () => {
        await expect(ownable.connect(admin).updateOwner()).to.be.revertedWith("SO_C0")
    })

    it("force error, can not update twice", async () => {
        await ownable.setOwner(alice.address)
        await ownable.connect(alice).updateOwner()
        await expect(ownable.connect(admin).updateOwner()).to.be.revertedWith("SO_C0")
    })
})
