pragma solidity 0.7.6;
import "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";

contract TestERC20 is ERC20PresetMinterPauser {
    // FIXME
    // when deploy the contract using create2
    // the msg.sender would be the address of Create2Deployer contract
    // which is hardcoded as 0x4e59b44847b379578588920ca78fbf26c0b4956c
    // and ERC20PresetMinterPauser set msg.sender as admin
    // https://rinkeby.etherscan.io/address/0x2789bbd5825f3253150abfa340107cf5a97eca43#events
    // TODO
    // const nonce = await web3.eth.getTransactionCount(deployer)
    // const futureAddress = ethers.utils.getContractAddress({ from: deployer, nonce: nonce+1 });
    constructor(string memory name, string memory symbol) ERC20PresetMinterPauser(name, symbol) {}

    function setMinter(address minter) external {
        grantRole(MINTER_ROLE, minter);
    }
}
