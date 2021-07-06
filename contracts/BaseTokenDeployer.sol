pragma solidity 0.7.6;

import { ERC20PresetMinterPauser } from "@openzeppelin/contracts/presets/ERC20PresetMinterPauser.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { Create2 } from "@openzeppelin/contracts/utils/Create2.sol";
import { BaseToken } from "./BaseToken.sol";

contract BaseTokenDeployer {
    function deploy(bytes32 salt, bytes memory bytecode) external returns (address) {
        address baseTokenAddr = Create2.deploy(0, salt, bytecode);

        // msg.sender would be our testnet deployer
        BaseToken baseToken = BaseToken(baseTokenAddr);
        baseToken.grantRole(baseToken.DEFAULT_ADMIN_ROLE(), msg.sender);
        baseToken.grantRole(baseToken.MINTER_ROLE(), msg.sender);
        baseToken.grantRole(baseToken.PAUSER_ROLE(), msg.sender);
    }
}
